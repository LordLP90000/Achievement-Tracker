import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MaintenanceIncompleteError, MaintenanceRefusedError, runMaintenance } from '../../src/main/maintenance.ts';
import { emailField } from '../../src/modules/accounts/account-mail.ts';
import { storeRewrappedKey } from '../../src/modules/accounts/rewrap-repository.ts';
import { rewrapDataKeys } from '../../src/modules/accounts/rewrap.ts';
import type { MaintenanceConfig } from '../../src/platform/config/config.ts';
import { createDataKeys } from '../../src/platform/crypto/data-keys.ts';
import { decryptText } from '../../src/platform/crypto/field-cipher.ts';
import { envKekSource, type Kek } from '../../src/platform/crypto/kek-source.ts';
import { generateDataKey, localKeyWrapper } from '../../src/platform/crypto/key-wrapper.ts';
import { createDatabaseClient, type DatabaseClient } from '../../src/platform/db/client.ts';
import { createDatabase, inTransaction } from '../../src/platform/db/database.ts';
import { createLogger } from '../../src/platform/logging/logger.ts';
import { startAccountsApp, type AccountsApp } from '../helpers/accounts-app.ts';
import { LogCapture } from '../helpers/log-capture.ts';

/**
 * KEK rotation (ADR-0020, Q-56): `rewrap-data-keys` re-wraps every account's data key under the new KEK, with the
 * migrator's role while the API and the worker are stopped. The app's accounts are wrapped by its KEK, the old one.
 */
describe('KEK rotation: every data key re-wrapped under the new KEK [ADR-0020, Q-56, E-11, R-ENC-01]', () => {
  let ctx: AccountsApp;
  let opened: DatabaseClient[] = [];

  const client = (url: string, applicationName = 'questline-maintenance') => {
    const created = createDatabaseClient({ url, applicationName });
    opened = [...opened, created];
    return created;
  };
  const migrator = () => createDatabase(client(ctx.database.urls.migrator));
  const newKek = () => envKekSource(randomBytes(32))();
  const config = (): MaintenanceConfig => ({
    appEnv: 'test',
    logLevel: 'info',
    databaseUrl: ctx.database.urls.migrator,
    replacedDatabaseUrl: undefined,
  });

  interface StoredKey {
    readonly blob: string;
    readonly kek_id: string;
    readonly kek_version: number;
    readonly rotated_at: string | null;
  }
  const storedKey = async (userId: string) => {
    const [row] = await ctx.admin.sql<StoredKey[]>`
      select encode(wrapped_dek, 'hex') as blob, kek_id, kek_version, rotated_at::text
      from user_keys where user_id = ${userId}`;
    return row === undefined ? undefined : { ...row };
  };
  /** The account's address, decrypted with its data key unwrapped by `kek`: its data is readable under that KEK. */
  const addressUnder = async (kek: Kek, userId: string) => {
    const [row] = await ctx.admin.sql<
      { wrapped_dek: Buffer; kek_id: string; kek_version: number; email_enc: Buffer }[]
    >`
      select k.wrapped_dek, k.kek_id, k.kek_version, u.email_enc
      from user_keys k join users u on u.id = k.user_id where k.user_id = ${userId}`;
    if (row === undefined) throw new Error('no account');
    const wrapped = { blob: row.wrapped_dek, kekId: kek.id, kekVersion: row.kek_version };
    return createDataKeys(localKeyWrapper(kek)).withKey(userId, wrapped, (dataKey) =>
      Promise.resolve(decryptText(dataKey, emailField(userId), row.email_enc)),
    );
  };

  beforeAll(async () => {
    ctx = await startAccountsApp();
  });

  beforeEach(async () => {
    await ctx.admin.sql`delete from users`;
  });

  afterEach(async () => {
    await Promise.all(opened.map((created) => created.close()));
    opened = [];
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('re-wraps every data key under the new KEK, batch by batch: each account’s data opens with it, not with the old', async () => {
    const accounts = [await ctx.account(), await ctx.account(), await ctx.account()];
    const next = await newKek();

    const result = await rewrapDataKeys(migrator(), { current: next, previous: [ctx.kek] }, ctx.clock.now(), {
      batchSize: 2,
    });

    expect(result).toEqual({ current: 0, rewrapped: 3, unknown: 0 });
    for (const account of accounts) {
      expect(await addressUnder(next, account.userId)).toBe(account.email);
      await expect(addressUnder(ctx.kek, account.userId)).rejects.toThrow();
    }
  });

  it('records the rotation on each key: the new item, its version, and when', async () => {
    const account = await ctx.account();
    const next: Kek = { ...(await newKek()), id: 'onepassword:vault/new', version: 3 };
    const now = ctx.clock.now();

    await rewrapDataKeys(migrator(), { current: next, previous: [ctx.kek] }, now);

    const [rotated] = await ctx.admin.sql<{ at: boolean }[]>`
      select rotated_at = ${now} as at from user_keys where user_id = ${account.userId}`;
    expect(await storedKey(account.userId)).toMatchObject({ kek_id: 'onepassword:vault/new', kek_version: 3 });
    expect(rotated?.at).toBe(true);
  });

  it('changes nothing on a second run', async () => {
    const account = await ctx.account();
    const next = await newKek();
    await rewrapDataKeys(migrator(), { current: next, previous: [ctx.kek] }, ctx.clock.now());
    const stored = await storedKey(account.userId);

    expect(await rewrapDataKeys(migrator(), { current: next, previous: [ctx.kek] }, ctx.clock.now())).toEqual({
      current: 1,
      rewrapped: 0,
      unknown: 0,
    });
    expect(await storedKey(account.userId)).toEqual(stored);
  });

  it('counts the keys no given KEK opens over every batch', async () => {
    for (const account of [await ctx.account(), await ctx.account()]) {
      const stray = localKeyWrapper(await newKek()).wrap(generateDataKey(), account.userId);
      await ctx.admin.sql`update user_keys set wrapped_dek = ${stray.blob} where user_id = ${account.userId}`;
    }

    expect(
      await rewrapDataKeys(migrator(), { current: await newKek(), previous: [ctx.kek] }, ctx.clock.now(), {
        batchSize: 1,
      }),
    ).toEqual({ current: 0, rewrapped: 0, unknown: 2 });
  });

  it('stores a re-wrapped key only over the one it replaces', async () => {
    const account = await ctx.account();
    const before = await storedKey(account.userId);
    const next = await newKek();
    const rewrapped = localKeyWrapper(next).wrap(generateDataKey(), account.userId);

    const stored = await inTransaction(migrator(), (tx) =>
      storeRewrappedKey(tx, account.userId, randomBytes(73), rewrapped, ctx.clock.now()),
    );

    expect(stored).toBe(false);
    expect(await storedKey(account.userId)).toEqual(before);
  });

  describe('as the maintenance command rewrap-data-keys', () => {
    const loggerFor = (logs: LogCapture) =>
      createLogger({ service: 'questline-maintenance', level: 'info' }, logs.stream);

    it('leaves a data key no given KEK opens as it is, counts it, and fails for a decision by hand', async () => {
      const account = await ctx.account();
      const lost = await ctx.account();
      const stray = localKeyWrapper(await newKek()).wrap(generateDataKey(), lost.userId);
      await ctx.admin.sql`update user_keys set wrapped_dek = ${stray.blob} where user_id = ${lost.userId}`;
      const before = await storedKey(lost.userId);
      const next = await newKek();
      const logs = new LogCapture();

      await expect(
        runMaintenance('rewrap-data-keys', config(), loggerFor(logs), { keks: { current: next, previous: [ctx.kek] } }),
      ).rejects.toBeInstanceOf(MaintenanceIncompleteError);

      expect(logs.records().find((record) => record['msg'] === 'data keys re-wrapped')).toMatchObject({
        current: 0,
        rewrapped: 1,
        unknown: 1,
      });
      expect(await storedKey(lost.userId)).toEqual(before);
      expect(await addressUnder(next, account.userId)).toBe(account.email);
      expect(logs.text).not.toContain(lost.userId);
    });

    it('refuses while the API is connected, and changes nothing', async () => {
      const account = await ctx.account();
      const before = await storedKey(account.userId);
      await client(ctx.database.urls.app, 'questline-api').sql`select 1`;

      await expect(
        runMaintenance('rewrap-data-keys', config(), loggerFor(new LogCapture()), {
          keks: { current: await newKek(), previous: [ctx.kek] },
        }),
      ).rejects.toBeInstanceOf(MaintenanceRefusedError);

      expect(await storedKey(account.userId)).toEqual(before);
    });
  });
});
