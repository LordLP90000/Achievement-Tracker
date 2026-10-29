import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { inject } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { loadBreachedPasswordFilter } from '../../src/modules/accounts/password-policy.ts';
import { createAccountsService } from '../../src/modules/accounts/service.ts';
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
import { createTestDatabase, type TestDatabase } from './database.ts';
import { FakeClock } from './fake-clock.ts';
import type { LogCapture } from './log-capture.ts';

export interface QueuedEmail {
  readonly userId: string;
  readonly template: string;
  readonly payload: { readonly to: string; readonly locale: string; readonly token?: string };
}

export interface AccountsApp {
  readonly app: FastifyInstance;
  readonly clock: FakeClock;
  readonly database: TestDatabase;
  /** Worker role: reads every row, like the background jobs. */
  readonly worker: DatabaseClient;
  /** Superuser, bypasses row-level security: arranges states the API cannot create (deactivation, a lost key). */
  readonly admin: DatabaseClient;
  blindIndex(email: string): Buffer;
  /** Number of Argon2id hashes computed so far. */
  hashCount(): number;
  /** Queued emails, decrypted as the worker will (KEK → data key → payload). */
  emails(): Promise<QueuedEmail[]>;
  close(): Promise<void>;
}

export interface AccountsAppOptions {
  readonly logCapture?: LogCapture;
  /** Argon2id concurrency; the default never refuses work in tests. */
  readonly hashing?: { readonly maxConcurrent: number; readonly maxQueued: number };
}

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
  const hasher: PasswordHasher = {
    ...argon2,
    hash: (password) => {
      hashes += 1;
      return argon2.hash(password);
    },
  };
  const logger = options.logCapture
    ? createLogger({ service: 'questline-api', level: 'info' }, options.logCapture.stream)
    : createLogger({ service: 'questline-api', level: 'silent' });
  const accounts = createAccountsService({
    db: createDatabase(api),
    clock,
    hasher,
    breachedPasswords: loadBreachedPasswordFilter(),
    blindIndexKey,
    dataKeys: createDataKeys(wrapper),
  });
  const app = buildApp({
    http: { trustProxyHops: 0 },
    logger,
    readiness: () => Promise.resolve(true),
    services: { accounts },
  });
  await app.ready();

  return {
    app,
    clock,
    database,
    worker,
    admin,
    blindIndex: (email) => emailBlindIndex(blindIndexKey, email),
    hashCount: () => hashes,
    async emails() {
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
        from email_outbox o join user_keys k on k.user_id = o.user_id`;
      return rows.map((row) => {
        const dataKey = wrapper.unwrap(
          { blob: row.wrapped_dek, kekId: row.kek_id, kekVersion: row.kek_version },
          row.user_id,
        );
        const payload = decryptText(
          dataKey,
          { userId: row.user_id, recordId: row.id, field: 'payload_enc' },
          row.payload_enc,
        );
        return { userId: row.user_id, template: row.template, payload: JSON.parse(payload) as QueuedEmail['payload'] };
      });
    },
    async close() {
      await app.close();
      await Promise.all([api.close(), worker.close(), admin.close()]);
      await database.drop();
    },
  };
}
