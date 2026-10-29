import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { inject } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { loadBreachedPasswordFilter } from '../../src/modules/accounts/password-policy.ts';
import { createEmailChangeService } from '../../src/modules/accounts/email-change-service.ts';
import { createPasswordsService } from '../../src/modules/accounts/password-service.ts';
import { createAccountsService } from '../../src/modules/accounts/service.ts';
import { createSessionsService } from '../../src/modules/sessions/service.ts';
import { principalOf, registerAuthGuard } from '../../src/modules/sessions/guard.ts';
import { emailBlindIndex } from '../../src/platform/crypto/blind-index.ts';
import { createDataKeys } from '../../src/platform/crypto/data-keys.ts';
import { decryptText } from '../../src/platform/crypto/field-cipher.ts';
import { envKekSource } from '../../src/platform/crypto/kek-source.ts';
import { localKeyWrapper } from '../../src/platform/crypto/key-wrapper.ts';
import { createArgon2idHasher, type PasswordHasher } from '../../src/platform/crypto/password.ts';
import { databaseUrl } from '../../src/platform/db/bootstrap.ts';
import { createDatabaseClient, type DatabaseClient } from '../../src/platform/db/client.ts';
import { createDatabase } from '../../src/platform/db/database.ts';
import { createLogger } from '../../src/platform/logging/logger.ts';
import { contractInject } from './contract.ts';
import { createTestDatabase, type TestDatabase } from './database.ts';
import { FakeClock } from './fake-clock.ts';
import type { LogCapture } from './log-capture.ts';

export interface QueuedEmail {
  readonly userId: string;
  readonly template: string;
  readonly payload: { readonly to: string; readonly locale: string; readonly token?: string };
}

export interface TestAccount {
  readonly email: string;
  readonly password: string;
  readonly userId: string;
}

export interface AccountsApp {
  readonly app: FastifyInstance;
  readonly clock: FakeClock;
  readonly database: TestDatabase;
  /** Worker role: reads every row, like the background jobs. */
  readonly worker: DatabaseClient;
  /** Superuser, bypasses row-level security: arranges states the API cannot create (deactivation, a lost key). */
  readonly admin: DatabaseClient;
  /** Runs after every successful or failed password verification, before the login continues (race tests). */
  afterPasswordVerified: (() => Promise<void>) | undefined;
  blindIndex(email: string): Buffer;
  /** Number of Argon2id hashes computed so far. */
  hashCount(): number;
  /** Number of Argon2id verifications (including those against the dummy hash) so far. */
  verifyCount(): number;
  /** JSON POST through the contract-validating inject. */
  post(url: string, body: unknown, headers?: Record<string, string>): Promise<LightMyRequestResponse>;
  /** Registers an account through the API and, unless `verified: false`, verifies it with the emailed token. */
  account(options?: { readonly verified?: boolean }): Promise<TestAccount>;
  /** Decrypts a field with the user's data key, as the API does. */
  decrypt(userId: string, recordId: string, field: string, blob: Buffer): Promise<string>;
  /** Queued emails, decrypted as the worker will (KEK → data key → payload). */
  emails(): Promise<QueuedEmail[]>;
  close(): Promise<void>;
}

export interface AccountsAppOptions {
  readonly logCapture?: LogCapture;
  /** Argon2id concurrency; the default never refuses work in tests. */
  readonly hashing?: { readonly maxConcurrent: number; readonly maxQueued: number };
}

export const TEST_PASSWORD = 'purple elephants dance quietly';

export async function startAccountsApp(options: AccountsAppOptions = {}): Promise<AccountsApp> {
  const database = await createTestDatabase();
  const role = (url: string) => createDatabaseClient({ url, applicationName: 'questline-test' });
  const [api, worker, admin] = [
    role(database.urls.app),
    role(database.urls.worker),
    role(databaseUrl(inject('database').adminUrl, database.name)),
  ];
  const clock = new FakeClock('2026-10-29T12:00:00Z');
  const wrapper = localKeyWrapper(await envKekSource(randomBytes(32))());
  const blindIndexKey = randomBytes(32);
  const argon2 = await createArgon2idHasher(options.hashing ?? { maxConcurrent: 4, maxQueued: 64 });
  let hashes = 0;
  let verifications = 0;
  const hasher: PasswordHasher = {
    ...argon2,
    hash: (password) => {
      hashes += 1;
      return argon2.hash(password);
    },
    verify: async (storedHash, password) => {
      verifications += 1;
      const matches = await argon2.verify(storedHash, password);
      await context.afterPasswordVerified?.();
      return matches;
    },
  };
  const logger = options.logCapture
    ? createLogger({ service: 'questline-api', level: 'info' }, options.logCapture.stream)
    : createLogger({ service: 'questline-api', level: 'silent' });
  const shared = {
    db: createDatabase(api),
    clock,
    hasher,
    blindIndexKey,
    dataKeys: createDataKeys(wrapper),
  };
  const breachedPasswords = loadBreachedPasswordFilter();
  const accounts = createAccountsService({ ...shared, breachedPasswords });
  const passwords = createPasswordsService({ ...shared, breachedPasswords });
  const emailChanges = createEmailChangeService(shared);
  const sessions = createSessionsService(shared);
  const app = buildApp({
    http: { trustProxyHops: 0 },
    logger,
    readiness: () => Promise.resolve(true),
    services: { accounts, emailChanges, passwords, sessions },
  });
  // A test-only route behind the same guard as `/v1`, to observe authentication without side effects.
  void app.register((scope, _options, done) => {
    registerAuthGuard(scope, sessions);
    scope.get('/__test/v1/whoami', (request) => principalOf(request));
    done();
  });
  await app.ready();

  const json = { 'content-type': 'application/json' };
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    contractInject(app, { method: 'POST', url, headers: { ...json, ...headers }, payload: JSON.stringify(body) });

  const emails = async (): Promise<QueuedEmail[]> => {
    const rows = await worker.sql<
      {
        id: string;
        user_id: string;
        template: string;
        payload_enc: Buffer;
        wrapped_dek: Buffer;
        kek_id: string;
        kek_version: number;
      }[]
    >`select o.id, o.user_id, o.template, o.payload_enc, k.wrapped_dek, k.kek_id, k.kek_version
      from email_outbox o join user_keys k on k.user_id = o.user_id
      order by o.created_at, o.xmin::text::bigint`; // the fake clock stands still: insertion order breaks ties
    return rows.map((row) => ({
      userId: row.user_id,
      template: row.template,
      payload: JSON.parse(
        decryptWith(row.user_id, row.id, 'payload_enc', row.payload_enc, {
          blob: row.wrapped_dek,
          kekId: row.kek_id,
          kekVersion: row.kek_version,
        }),
      ) as QueuedEmail['payload'],
    }));
  };

  const decryptWith = (
    userId: string,
    recordId: string,
    field: string,
    blob: Buffer,
    key: { blob: Buffer; kekId: string; kekVersion: number },
  ): string => decryptText(wrapper.unwrap(key, userId), { userId, recordId, field }, blob);

  const context: AccountsApp = {
    app,
    clock,
    database,
    worker,
    admin,
    afterPasswordVerified: undefined,
    blindIndex: (email) => emailBlindIndex(blindIndexKey, email),
    hashCount: () => hashes,
    verifyCount: () => verifications,
    post,
    async account(accountOptions = {}) {
      const email = `user-${randomUUID().slice(0, 8)}@example.test`;
      const registered = await post('/v1/auth/register', {
        email,
        password: TEST_PASSWORD,
        privacy_policy_version: '2026-10-01',
        age_confirmed: true,
      });
      if (registered.statusCode !== 202) throw new Error(`registration failed: ${String(registered.statusCode)}`);
      const [user] = await worker.sql<{ id: string }[]>`
        select id from users where email_blind_index = ${emailBlindIndex(blindIndexKey, email)}`;
      if (user === undefined) throw new Error('registered account not found');
      if (accountOptions.verified !== false) {
        const token = (await emails()).findLast((queued) => queued.payload.to === email)?.payload.token ?? '';
        const verified = await post('/v1/auth/verify-email', { token });
        if (verified.statusCode !== 204) throw new Error(`verification failed: ${String(verified.statusCode)}`);
      }
      return { email, password: TEST_PASSWORD, userId: user.id };
    },
    async decrypt(userId, recordId, field, blob) {
      const [key] = await worker.sql<{ wrapped_dek: Buffer; kek_id: string; kek_version: number }[]>`
        select wrapped_dek, kek_id, kek_version from user_keys where user_id = ${userId}`;
      if (key === undefined) throw new Error('the account has no data key');
      return decryptWith(userId, recordId, field, blob, {
        blob: key.wrapped_dek,
        kekId: key.kek_id,
        kekVersion: key.kek_version,
      });
    },
    emails,
    async close() {
      await app.close();
      await Promise.all([api.close(), worker.close(), admin.close()]);
      await database.drop();
    },
  };
  return context;
}
