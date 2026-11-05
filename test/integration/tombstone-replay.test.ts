import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { MaintenanceRefusedError, runMaintenance } from '../../src/main/maintenance.ts';
import { deleteTombstonedAccounts } from '../../src/modules/privacy/tombstone-repository.ts';
import { replayTombstones } from '../../src/modules/privacy/tombstone-replay.ts';
import type { MaintenanceConfig } from '../../src/platform/config/config.ts';
import { databaseUrl } from '../../src/platform/db/bootstrap.ts';
import { createDatabaseClient, type DatabaseClient } from '../../src/platform/db/client.ts';
import { createDatabase, inReadOnlyTransaction, inTransaction } from '../../src/platform/db/database.ts';
import { deletedUserTombstones } from '../../src/platform/db/schema/index.ts';
import { connectedApplications } from '../../src/platform/db/sessions.ts';
import { createLogger } from '../../src/platform/logging/logger.ts';
import { startAccountsApp, type AccountsApp } from '../helpers/accounts-app.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/database.ts';
import { bearer, goalUser } from '../helpers/goals.ts';
import { LogCapture } from '../helpers/log-capture.ts';

const DELETED_AT = '2026-10-20T10:00:00.000Z';

/**
 * Tombstone replay after a backup restore (Q-13, ADR-0006, ADR-0020; threats I-18, RR-4). The app's database plays the
 * restored one: it still holds accounts that were deleted after the backup was taken. `before` plays the database the
 * restore replaced, which holds their tombstones. The replay runs with the migrator's role, as the maintenance job.
 */
describe('tombstone replay after a restore [Q-13, I-18, RR-4]', () => {
  let ctx: AccountsApp;
  let before: TestDatabase;
  let beforeAdmin: DatabaseClient;
  let opened: DatabaseClient[] = [];

  const client = (url: string, applicationName: string) => {
    const created = createDatabaseClient({ url, applicationName });
    opened = [...opened, created];
    return created;
  };
  const restored = () => createDatabase(client(ctx.database.urls.migrator, 'questline-maintenance'));
  const replaced = () => createDatabase(client(before.urls.migrator, 'questline-maintenance'));
  const bury = (admin: DatabaseClient, userId: string) =>
    admin.sql`insert into deleted_user_tombstones (user_id, deleted_at) values (${userId}, ${DELETED_AT})`;
  const tombstonesIn = async (admin: DatabaseClient) =>
    (
      await admin.sql<{ user_id: string; deleted_at: string }[]>`
        select user_id, to_char(deleted_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as deleted_at
        from deleted_user_tombstones order by user_id`
    ).map(({ user_id: userId, deleted_at: deletedAt }) => ({ userId, deletedAt }));
  /** The user's rows per table — the account and every table with a `user_id` but the tombstones — if any. */
  const rowsOf = async (userId: string) => {
    const tables = await ctx.admin.sql<{ table_name: string }[]>`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'user_id' and table_name <> 'deleted_user_tombstones'`;
    const counts: Record<string, number> = {};
    const [account] = await ctx.admin.sql<{ count: number }[]>`
      select count(*)::int as count from users where id = ${userId}`;
    if (account !== undefined && account.count > 0) counts['users'] = account.count;
    for (const { table_name: table } of tables) {
      const [row] = await ctx.admin.sql<{ count: number }[]>`
        select count(*)::int as count from ${ctx.admin.sql(table)} where user_id = ${userId}`;
      if (row !== undefined && row.count > 0) counts[table] = row.count;
    }
    return counts;
  };
  const create = async (url: string, token: string, body: unknown) => {
    const response = await ctx.post(url, body, { ...bearer(token), 'idempotency-key': randomUUID() });
    if (response.statusCode !== 201) throw new Error(`${url} answered ${String(response.statusCode)}`);
    return response.json<{ id: string }>();
  };

  beforeAll(async () => {
    ctx = await startAccountsApp();
    before = await createTestDatabase();
    beforeAdmin = createDatabaseClient({
      url: databaseUrl(inject('database').adminUrl, before.name),
      applicationName: 'questline-test',
    });
  });

  afterAll(async () => {
    await beforeAdmin.close();
    await before.drop();
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.admin.sql`delete from users`;
    await ctx.admin.sql`delete from deleted_user_tombstones`;
    await beforeAdmin.sql`delete from deleted_user_tombstones`;
  });

  afterEach(async () => {
    await Promise.all(opened.map((created) => created.close()));
    opened = [];
  });

  it('deletes every account the replaced database has a tombstone for, with everything it owned, and keeps the rest', async () => {
    const deleted = await goalUser(ctx);
    const kept = await goalUser(ctx);
    const achievement = await create('/v1/achievements', deleted.token, { title: 'Run a marathon' });
    await create(`/v1/achievements/${achievement.id}/quests`, deleted.token, {
      title: 'Run 42 km',
      type: 'one_time',
      size: 'S',
    });
    await bury(beforeAdmin, deleted.userId);
    const deletedRows = await rowsOf(deleted.userId);
    const keptRows = await rowsOf(kept.userId);

    expect(await replayTombstones(restored(), replaced())).toEqual({ imported: 1, deleted: 1 });

    expect(Object.keys(deletedRows)).toEqual(
      expect.arrayContaining(['users', 'user_keys', 'consents', 'sessions', 'achievements', 'quests', 'audit_events']),
    );
    expect(await rowsOf(deleted.userId)).toEqual({});
    expect(await rowsOf(kept.userId)).toEqual(keptRows);
  });

  it('takes the tombstones over with their dates, so each still expires 35 days after its deletion', async () => {
    const user = await ctx.account();
    const unknown = randomUUID();
    await bury(beforeAdmin, user.userId);
    await bury(beforeAdmin, unknown);

    expect(await replayTombstones(restored(), replaced())).toEqual({ imported: 2, deleted: 1 });

    expect(await tombstonesIn(ctx.admin)).toEqual(
      [user.userId, unknown].toSorted().map((userId) => ({ userId, deletedAt: DELETED_AT })),
    );
  });

  it('changes nothing when run again', async () => {
    const user = await ctx.account();
    const kept = await ctx.account();
    await bury(beforeAdmin, user.userId);
    await replayTombstones(restored(), replaced());
    const keptRows = await rowsOf(kept.userId);

    expect(await replayTombstones(restored(), replaced())).toEqual({ imported: 0, deleted: 0 });

    expect(await rowsOf(kept.userId)).toEqual(keptRows);
    expect(await tombstonesIn(ctx.admin)).toEqual([{ userId: user.userId, deletedAt: DELETED_AT }]);
  });

  it('without the replaced database, replays the tombstones the restored one holds: a run stopped after taking them over', async () => {
    const user = await ctx.account();
    await bury(ctx.admin, user.userId);

    expect(await replayTombstones(restored(), undefined)).toEqual({ imported: 0, deleted: 1 });

    expect(await rowsOf(user.userId)).toEqual({});
  });

  it('deletes in batches until no account a tombstone names is left', async () => {
    const users = [await ctx.account(), await ctx.account(), await ctx.account()];
    for (const user of users) await bury(beforeAdmin, user.userId);

    expect(await replayTombstones(restored(), replaced(), { batchSize: 2 })).toEqual({ imported: 3, deleted: 3 });

    for (const user of users) expect(await rowsOf(user.userId)).toEqual({});
  });

  it('deletes at most one batch of accounts per statement, so each transaction stays bounded', async () => {
    const users = [await ctx.account(), await ctx.account(), await ctx.account()];
    for (const user of users) await bury(ctx.admin, user.userId);

    expect(await inTransaction(restored(), (tx) => deleteTombstonedAccounts(tx, 2))).toBe(2);

    const left = await Promise.all(users.map(async (user) => Object.keys(await rowsOf(user.userId)).length > 0));
    expect(left.filter(Boolean)).toHaveLength(1);
  });

  it('refuses batches of no account, which would never end', async () => {
    await expect(replayTombstones(restored(), undefined, { batchSize: 0 })).rejects.toThrow(RangeError);
  });

  it('reads the replaced database in a read-only transaction, which refuses any change', async () => {
    const write = inReadOnlyTransaction(replaced(), (tx) =>
      tx.insert(deletedUserTombstones).values({ userId: randomUUID(), deletedAt: new Date(DELETED_AT) }),
    );

    await expect(write).rejects.toThrow();
    expect(await tombstonesIn(beforeAdmin)).toEqual([]);
  });

  it('counts only other sessions as running processes, never the one that asks', async () => {
    const asking = createDatabase(client(ctx.database.urls.migrator, 'questline-api'));

    expect(await connectedApplications(asking, ['questline-api'])).toEqual([]);
  });

  it('only reads the replaced database: its tombstones stay as they were', async () => {
    const user = await ctx.account();
    await bury(beforeAdmin, user.userId);

    await replayTombstones(restored(), replaced());

    expect(await tombstonesIn(beforeAdmin)).toEqual([{ userId: user.userId, deletedAt: DELETED_AT }]);
  });

  describe('as the maintenance command replay-after-restore [ADR-0020]', () => {
    const config = (): MaintenanceConfig => ({
      appEnv: 'test',
      logLevel: 'info',
      databaseUrl: ctx.database.urls.migrator,
      replacedDatabaseUrl: before.urls.migrator,
    });
    const loggerFor = (logs: LogCapture) =>
      createLogger({ service: 'questline-maintenance', level: 'info' }, logs.stream);

    it('replays and logs how many tombstones it took over and accounts it deleted, never an account', async () => {
      const user = await ctx.account();
      await bury(beforeAdmin, user.userId);
      const logs = new LogCapture();

      await runMaintenance('replay-after-restore', config(), loggerFor(logs));

      expect(logs.records().find((record) => record['msg'] === 'replayed after restore')).toMatchObject({
        imported: 1,
        deleted: 1,
      });
      expect(logs.text).not.toContain(user.userId);
      expect(await rowsOf(user.userId)).toEqual({});
    });

    it('is not stopped by an API connected to another database of the same server', async () => {
      const user = await ctx.account();
      await bury(ctx.admin, user.userId);
      const elsewhere = client(before.urls.app, 'questline-api');
      await elsewhere.sql`select 1`;

      await runMaintenance(
        'replay-after-restore',
        { ...config(), replacedDatabaseUrl: undefined },
        loggerFor(new LogCapture()),
      );

      expect(await rowsOf(user.userId)).toEqual({});
    });

    it.each([
      ['the API', 'questline-api', 'restored'],
      ['the worker', 'questline-worker', 'restored'],
      ['the API', 'questline-api', 'replaced'],
    ])(
      'refuses to run while %s is connected to the %s database, and changes nothing',
      async (_name, application, side) => {
        const user = await ctx.account();
        await bury(beforeAdmin, user.userId);
        const running = client(side === 'restored' ? ctx.database.urls.app : before.urls.app, application);
        await running.sql`select 1`;
        const logs = new LogCapture();

        await expect(runMaintenance('replay-after-restore', config(), loggerFor(logs))).rejects.toBeInstanceOf(
          MaintenanceRefusedError,
        );

        expect(logs.records().find((record) => record['msg'] === 'maintenance refused')).toMatchObject({
          connected: [application],
        });
        expect(Object.keys(await rowsOf(user.userId))).toContain('users');
        expect(await tombstonesIn(ctx.admin)).toEqual([]);
      },
    );
  });
});
