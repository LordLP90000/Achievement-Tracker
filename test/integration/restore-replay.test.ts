import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { MaintenanceIncompleteError, runMaintenance } from '../../src/main/maintenance.ts';
import { replayAfterRestore } from '../../src/modules/privacy/restore-replay.ts';
import type { MaintenanceConfig } from '../../src/platform/config/config.ts';
import { createDatabaseFromTemplate, databaseUrl, dropDatabase } from '../../src/platform/db/bootstrap.ts';
import { createDatabaseClient, type DatabaseClient } from '../../src/platform/db/client.ts';
import { createDatabase } from '../../src/platform/db/database.ts';
import { createLogger } from '../../src/platform/logging/logger.ts';
import { startAccountsApp, type AccountsApp, type TestAccount } from '../helpers/accounts-app.ts';
import { LogCapture } from '../helpers/log-capture.ts';

const NEW_PASSWORD = 'seven silver swans swimming';
const NOW_ISO = '2026-11-05T12:00:00Z';

interface Backup {
  readonly name: string;
  /** An administrator on the restored database, for the test's own reads. */
  readonly admin: DatabaseClient;
  readonly migratorUrl: string;
}

/**
 * Q-57 (ADR-0020 as amended): after a restore, what users changed after the restore point is taken over from the
 * replaced database. The app's database plays the replaced one and goes on after the backup; the backup is a copy of
 * it (`CREATE DATABASE … TEMPLATE`), and the replay runs on that copy with the migrator's role, as the job does.
 */
describe('replay after a restore: the changes since the restore point [Q-57, ADR-0020]', () => {
  let ctx: AccountsApp;
  let backups: Backup[] = [];
  let opened: DatabaseClient[] = [];

  const client = (url: string) => {
    const created = createDatabaseClient({ url, applicationName: 'questline-maintenance' });
    opened = [...opened, created];
    return created;
  };
  /** The backup: a copy of the app's database as it is now. Its sessions are ended first, as a copy needs. */
  const takeBackup = async (): Promise<Backup> => {
    const { adminUrl, host, port, passwords } = inject('database');
    const name = `backup_${randomUUID().replaceAll('-', '')}`;
    const server = createDatabaseClient({ url: adminUrl, applicationName: 'questline-test' });
    try {
      await server.sql`
        select pg_terminate_backend(pid) from pg_stat_activity
        where datname = ${ctx.database.name} and pid <> pg_backend_pid()`;
    } finally {
      await server.close();
    }
    await createDatabaseFromTemplate(adminUrl, name, ctx.database.name);
    const backup: Backup = {
      name,
      admin: createDatabaseClient({ url: databaseUrl(adminUrl, name), applicationName: 'questline-test' }),
      migratorUrl: `postgres://questline_migrator:${encodeURIComponent(passwords.migrator)}@${host}:${String(port)}/${name}`,
    };
    backups = [...backups, backup];
    // Users go on after the backup: what they change from now on is later than anything in it.
    ctx.clock.advance({ minutes: 1 });
    return backup;
  };
  const replay = (backup: Backup, batchSize?: number) =>
    replayAfterRestore(createDatabase(client(backup.migratorUrl)), createDatabase(client(ctx.database.urls.worker)), {
      now: ctx.clock.now(),
      ...(batchSize === undefined ? {} : { batchSize }),
    });

  const login = async ({ email, password }: { email: string; password: string }) => {
    const response = await ctx.post('/v1/auth/login', { email, password, client: 'ios' });
    if (response.statusCode !== 200) throw new Error(`login answered ${String(response.statusCode)}`);
    return response.json<{ access_token: string }>().access_token;
  };
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  const requestDeletion = async (account: TestAccount) => {
    const response = await ctx.app.inject({ method: 'DELETE', url: '/v1/me', headers: bearer(await login(account)) });
    if (response.statusCode !== 202) throw new Error(`deletion answered ${String(response.statusCode)}`);
  };
  const changePassword = async (account: TestAccount) => {
    const token = await login(account);
    const response = await ctx.post(
      '/v1/me/password',
      { current_password: account.password, new_password: NEW_PASSWORD },
      bearer(token),
    );
    if (response.statusCode !== 204) throw new Error(`password change answered ${String(response.statusCode)}`);
  };
  const changeAddress = async (account: TestAccount, address: string) => {
    await ctx.post('/v1/me/email-change', { new_email: address }, bearer(await login(account)));
    const link = (await ctx.emails()).findLast(
      (queued) => queued.template === 'email_change_verify' && queued.payload.to === address,
    );
    const response = await ctx.post('/v1/me/email-change/confirm', { token: link?.payload.token ?? 'missing' });
    if (response.statusCode !== 204) throw new Error(`email change answered ${String(response.statusCode)}`);
  };
  const newAddress = () => `moved-${randomUUID().slice(0, 8)}@example.test`;
  const verify = async (account: TestAccount) => {
    const link = (await ctx.emails()).findLast(
      (queued) => queued.template === 'verify_email' && queued.payload.to === account.email,
    );
    const response = await ctx.post('/v1/auth/verify-email', { token: link?.payload.token ?? 'missing' });
    if (response.statusCode !== 204) throw new Error(`verification answered ${String(response.statusCode)}`);
  };

  interface AccountRow {
    readonly deactivated_at: string | null;
    readonly password_hash: string;
    readonly password_changed_at: string;
    readonly email_enc: string;
    readonly email_blind_index: string;
    readonly email_verified_at: string | null;
    readonly version: number;
  }
  /** The account's row as text, so both databases' rows compare alike. */
  const accountIn = async (db: DatabaseClient, userId: string): Promise<AccountRow | undefined> => {
    const [row] = await db.sql<AccountRow[]>`
      select deactivated_at::text, password_hash, password_changed_at::text, encode(email_enc, 'hex') as email_enc,
             encode(email_blind_index, 'hex') as email_blind_index, email_verified_at::text, version
      from users where id = ${userId}`;
    return row === undefined ? undefined : { ...row };
  };
  const addressOf = (row: AccountRow | undefined) => ({
    email_enc: row?.email_enc,
    email_blind_index: row?.email_blind_index,
    email_verified_at: row?.email_verified_at,
  });
  const count = async (db: DatabaseClient, table: string) =>
    (await db.sql<{ count: number }[]>`select count(*)::int as count from ${db.sql(table)}`)[0]?.count;

  beforeAll(async () => {
    ctx = await startAccountsApp();
    ctx.clock.set(NOW_ISO);
  });

  afterEach(async () => {
    await Promise.all(opened.map((created) => created.close()));
    opened = [];
    for (const backup of backups) {
      await backup.admin.close();
      await dropDatabase(inject('database').adminUrl, backup.name);
    }
    backups = [];
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('takes over deletion requests made after the restore point, with their dates, and reactivations', async () => {
    const leaving = await ctx.account();
    const returning = await ctx.account();
    await requestDeletion(returning);
    const backup = await takeBackup();
    const restoredBefore = {
      leaving: await accountIn(backup.admin, leaving.userId),
      returning: await accountIn(backup.admin, returning.userId),
    };
    await requestDeletion(leaving);
    await login(returning);

    expect(await replay(backup)).toMatchObject({ deletionStates: 2, passwords: 0, addresses: 0 });

    const [updated] = await backup.admin.sql<{ updated_at: string }[]>`
      select updated_at::text from users where id = ${leaving.userId}`;
    const [now] = await backup.admin.sql<{ now: string }[]>`select ${ctx.clock.now()}::timestamptz::text as now`;
    expect(updated?.updated_at).toBe(now?.now);

    for (const [account, before] of [
      [leaving, restoredBefore.leaving],
      [returning, restoredBefore.returning],
    ] as const) {
      const replaced = await accountIn(ctx.admin, account.userId);
      const after = await accountIn(backup.admin, account.userId);
      expect(after?.deactivated_at).toBe(replaced?.deactivated_at);
      // No ETag a client kept from either database matches the account any more.
      expect(after?.version).toBeGreaterThan(Math.max(before?.version ?? 0, replaced?.version ?? 0));
    }
    expect([
      restoredBefore.leaving?.deactivated_at,
      (await accountIn(ctx.admin, leaving.userId))?.deactivated_at,
    ]).toEqual([null, expect.any(String)]);
    expect([
      restoredBefore.returning?.deactivated_at,
      (await accountIn(ctx.admin, returning.userId))?.deactivated_at,
    ]).toEqual([expect.any(String), null]);
  });

  it('takes over a password changed after the restore point, and leaves every other account as it was', async () => {
    const changing = await ctx.account();
    const keeping = await ctx.account();
    const backup = await takeBackup();
    const kept = await accountIn(backup.admin, keeping.userId);
    await changePassword(changing);

    expect(await replay(backup)).toMatchObject({ deletionStates: 0, passwords: 1, addresses: 0 });

    const replaced = await accountIn(ctx.admin, changing.userId);
    const after = await accountIn(backup.admin, changing.userId);
    expect([after?.password_hash, after?.password_changed_at]).toEqual([
      replaced?.password_hash,
      replaced?.password_changed_at,
    ]);
    expect(await accountIn(backup.admin, keeping.userId)).toEqual(kept);
  });

  it('takes over changed addresses, also when two accounts swapped theirs, one account per batch', async () => {
    const first = await ctx.account();
    const second = await ctx.account();
    const backup = await takeBackup();
    const swapped = {
      first: (await accountIn(backup.admin, second.userId))?.email_blind_index,
      second: (await accountIn(backup.admin, first.userId))?.email_blind_index,
    };
    const parking = newAddress();
    await changeAddress(first, parking);
    await changeAddress(second, first.email);
    await changeAddress({ ...first, email: parking }, second.email);

    expect(await replay(backup, 1)).toMatchObject({ addresses: 2, addressConflicts: 0, unverifiedDeleted: 0 });

    for (const account of [first, second]) {
      expect(addressOf(await accountIn(backup.admin, account.userId))).toEqual(
        addressOf(await accountIn(ctx.admin, account.userId)),
      );
    }
    expect({
      first: (await accountIn(backup.admin, first.userId))?.email_blind_index,
      second: (await accountIn(backup.admin, second.userId))?.email_blind_index,
    }).toEqual(swapped);
  });

  it('takes over an address verified after the restore point: unverified, the account would be purged after 7 days', async () => {
    const late = await ctx.account({ verified: false });
    const backup = await takeBackup();
    await verify(late);

    expect(await replay(backup)).toMatchObject({ verifications: 1, addresses: 0 });

    const after = await accountIn(backup.admin, late.userId);
    expect(after?.email_verified_at).toBe((await accountIn(ctx.admin, late.userId))?.email_verified_at);
    expect(after?.email_verified_at).not.toBeNull();
  });

  it('never deletes an account the replaced database holds: a move that would need its address is held back too', async () => {
    const missing = await ctx.account();
    const blocked = await ctx.account({ verified: false });
    const taking = await ctx.account();
    const backup = await takeBackup();
    const before = await accountIn(backup.admin, taking.userId);
    const blockedBefore = await accountIn(backup.admin, blocked.userId);
    // Gone from the replaced database without a tombstone, so its address stays taken in the restored one.
    await ctx.admin.sql`delete from users where id = ${missing.userId}`;
    await verify(blocked);
    await changeAddress(blocked, missing.email);
    await changeAddress(taking, blocked.email);

    expect(await replay(backup)).toMatchObject({ addresses: 0, addressConflicts: 2, unverifiedDeleted: 0 });

    // Both stay as restored, for the decision by hand the conflicts ask for.
    expect(await accountIn(backup.admin, blocked.userId)).toEqual(blockedBefore);
    expect(await accountIn(backup.admin, taking.userId)).toEqual(before);
  });

  it('deletes an unverified account the replaced database purged when another account took its address', async () => {
    const stale = await ctx.account({ verified: false });
    const taking = await ctx.account();
    const backup = await takeBackup();
    // The hourly purge of unverified accounts (S-12), in the replaced database: it writes no tombstone.
    await ctx.admin.sql`delete from users where id = ${stale.userId}`;
    await changeAddress(taking, stale.email);

    expect(await replay(backup)).toMatchObject({ addresses: 1, addressConflicts: 0, unverifiedDeleted: 1 });

    expect(await accountIn(backup.admin, stale.userId)).toBeUndefined();
    expect(addressOf(await accountIn(backup.admin, taking.userId))).toEqual(
      addressOf(await accountIn(ctx.admin, taking.userId)),
    );
  });

  it('keeps both and fails for a decision by hand when a verified account the replaced database lacks holds a moved address', async () => {
    const missing = await ctx.account();
    const taking = await ctx.account();
    const changing = await ctx.account();
    const backup = await takeBackup();
    const takingBefore = await accountIn(backup.admin, taking.userId);
    // Gone from the replaced database without a tombstone: no job deletes a verified account that way.
    await ctx.admin.sql`delete from users where id = ${missing.userId}`;
    await changeAddress(taking, missing.email);
    await changePassword(changing);
    const logs = new LogCapture();
    const config: MaintenanceConfig = {
      appEnv: 'test',
      logLevel: 'info',
      databaseUrl: backup.migratorUrl,
      replacedDatabaseUrl: ctx.database.urls.worker,
    };

    await expect(
      runMaintenance(
        'replay-after-restore',
        config,
        createLogger({ service: 'questline-maintenance', level: 'info' }, logs.stream),
      ),
    ).rejects.toBeInstanceOf(MaintenanceIncompleteError);

    expect(logs.records().find((record) => record['msg'] === 'replayed after restore')).toMatchObject({
      passwords: 1,
      addresses: 0,
      addressConflicts: 1,
      unverifiedDeleted: 0,
    });
    expect(await accountIn(backup.admin, taking.userId)).toEqual(takingBefore);
    expect(await accountIn(backup.admin, missing.userId)).toBeDefined();
    expect(logs.text).not.toContain(taking.userId);
  });

  it('revokes every session of the restored database with its tokens: every user signs in again', async () => {
    const account = await ctx.account();
    await login(account);
    const backup = await takeBackup();
    const sessions = await count(backup.admin, 'sessions');

    const result = await replay(backup);

    expect(sessions).toBeGreaterThan(0);
    expect(result.sessions).toBe(sessions);
    expect([await count(backup.admin, 'sessions'), await count(backup.admin, 'session_tokens')]).toEqual([0, 0]);
  });

  it('changes nothing on a second run', async () => {
    const leaving = await ctx.account();
    const changing = await ctx.account();
    const backup = await takeBackup();
    await requestDeletion(leaving);
    const moved = newAddress();
    await changeAddress(changing, moved);
    await changePassword({ ...changing, email: moved });
    await replay(backup);
    const rows = [await accountIn(backup.admin, leaving.userId), await accountIn(backup.admin, changing.userId)];

    expect(await replay(backup)).toEqual({
      imported: 0,
      deleted: 0,
      deletionStates: 0,
      passwords: 0,
      verifications: 0,
      addresses: 0,
      addressConflicts: 0,
      unverifiedDeleted: 0,
      sessions: 0,
    });
    expect([await accountIn(backup.admin, leaving.userId), await accountIn(backup.admin, changing.userId)]).toEqual(
      rows,
    );
  });
});
