import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptText } from '../../src/platform/crypto/field-cipher.ts';
import { startAccountsApp, TEST_PASSWORD, type AccountsApp } from '../helpers/accounts-app.ts';
import { contractInject } from '../helpers/contract.ts';
import { includedColumns, loadInventory, type Inventory } from '../helpers/data-inventory.ts';
import { bearer, goalUser, type GoalUser } from '../helpers/goals.ts';

const START = '2026-10-29T12:00:00Z';
const TODAY = '2026-10-29';

type Row = Record<string, unknown>;
interface ExportedQuest extends Row {
  readonly check_ins: Row[];
}
interface ExportedAchievement extends Row {
  readonly gambles: Row[];
  readonly quests: ExportedQuest[];
}
interface ExportDocument {
  readonly account: Row;
  readonly consents: Row[];
  readonly sessions: Row[];
  readonly achievements: ExportedAchievement[];
  readonly xp_events: Row[];
  readonly badges: Row[];
  readonly audit_events: Row[];
}

/** Where each table's rows are in the export (docs/privacy/data-inventory.md §6, step 6). */
const SECTIONS: Readonly<Record<string, (document: ExportDocument) => Row[]>> = {
  users: (document) => [document.account],
  consents: (document) => document.consents,
  sessions: (document) => document.sessions,
  achievements: (document) => document.achievements,
  gambles: (document) => document.achievements.flatMap((achievement) => achievement.gambles),
  quests: (document) => document.achievements.flatMap((achievement) => achievement.quests),
  check_ins: (document) =>
    document.achievements.flatMap((achievement) => achievement.quests).flatMap((quest) => quest.check_ins),
  xp_events: (document) => document.xp_events,
  badges: (document) => document.badges,
  audit_events: (document) => document.audit_events,
};
/** Records that list their children with them. */
const NESTED: Readonly<Record<string, readonly string[]>> = {
  achievements: ['gambles', 'quests'],
  quests: ['check_ins'],
};
/** Every table's `user_id` is the account itself, exported once as `account.id`. */
const exportedColumns = (inventory: Inventory, table: string) =>
  includedColumns(inventory, table).filter((column) => column !== 'user_id');
const keyOf = (column: string) => column.replace(/_enc$/, '');
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T/;

/**
 * The export is complete (R-PRIV-05, R-PRIV-08): a seeded account with rows in every exported table comes back with
 * every column the data inventory marks `included`, holding the stored value, decrypted — and with nothing else.
 */
describe('export completeness against the data inventory [R-PRIV-05, R-PRIV-08, I-12]', () => {
  let ctx: AccountsApp;
  let inventory: Inventory;
  let user: GoalUser;
  let document: ExportDocument;

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    token: string,
    body?: unknown,
    etag?: string,
  ) =>
    contractInject(ctx.app, {
      method,
      url,
      headers: {
        ...bearer(token),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(method === 'POST' && body !== undefined && !url.startsWith('/v1/auth') && !url.startsWith('/v1/me')
          ? { 'idempotency-key': randomUUID() }
          : {}),
        ...(etag === undefined ? {} : { 'if-match': etag }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  /** Seeding must not go wrong silently. */
  const must = async (expected: number, response: ReturnType<typeof call>) => {
    const { statusCode, body } = await response;
    if (statusCode !== expected) throw new Error(`expected ${String(expected)}, got ${String(statusCode)}: ${body}`);
  };
  const etagOf = async (url: string) => String((await call('GET', url, user.token)).headers.etag);
  const create = async (url: string, body: unknown) => {
    const response = await call('POST', url, user.token, body);
    if (response.statusCode !== 201) throw new Error(`${url} answered ${String(response.statusCode)}`);
    return response.json<{ id: string }>();
  };
  const login = async (client: 'ios' | 'android', deviceLabel?: string) => {
    const response = await ctx.post('/v1/auth/login', {
      email: user.email,
      password: TEST_PASSWORD,
      client,
      ...(deviceLabel === undefined ? {} : { device_label: deviceLabel }),
    });
    return response.json<{ access_token: string }>().access_token;
  };

  /** An account with rows in every exported table, every nullable encrypted column filled somewhere. */
  async function seed(): Promise<void> {
    user = await goalUser(ctx);
    await must(200, call('PATCH', '/v1/me', user.token, { nickname: 'Ally' }, await etagOf('/v1/me')));
    await must(204, call('DELETE', '/v1/me/consents/goal_content', user.token));
    await must(201, call('POST', '/v1/me/consents', user.token, { type: 'goal_content', version: '2026-10-01' }));
    await login('android', 'Pixel 9');
    await must(204, call('POST', '/v1/auth/logout', await login('ios')));
    await ctx.admin.sql`
      insert into xp_events (id, user_id, kind, amount, local_date, created_at)
      values (${randomUUID()}, ${user.userId}, 'quest_completed', 1000, ${TODAY}, ${ctx.clock.now()})`;

    const done = await create('/v1/achievements', { title: 'Done', target_date: '2026-12-31' });
    const doneQuest = await create(`/v1/achievements/${done.id}/quests`, {
      title: 'Only step',
      type: 'one_time',
      size: 'S',
    });
    await create(`/v1/quests/${doneQuest.id}/check-ins`, { local_date: TODAY });

    const paused = await create('/v1/achievements', { title: 'Paused', target_date: '2026-11-30' });
    await create(`/v1/achievements/${paused.id}/quests`, { title: 'Waits', type: 'one_time', size: 'M' });
    await create(`/v1/achievements/${paused.id}/gambles`, {});
    const pausedUrl = `/v1/achievements/${paused.id}`;
    await must(200, call('PATCH', pausedUrl, user.token, { status: 'paused' }, await etagOf(pausedUrl)));

    const goal = await create('/v1/achievements', {
      title: 'Half marathon',
      description: 'Under two hours',
      motivation: 'Health',
      category: 'Running',
      target_date: '2026-11-30',
      is_private: true,
    });
    const first = await create(`/v1/achievements/${goal.id}/quests`, {
      title: 'First 5 km',
      notes: 'Slowly',
      type: 'one_time',
      size: 'M',
    });
    const distance = await create(`/v1/achievements/${goal.id}/quests`, {
      title: 'Distance',
      type: 'target',
      size: 'L',
      target: { start_value: '0', target_value: '21.1', unit: 'km' },
    });
    await create(`/v1/achievements/${goal.id}/quests`, {
      title: 'Daily run',
      type: 'habit',
      size: 'S',
      prerequisite_quest_id: first.id,
      habit: { period: 'day', times_per_period: 1, period_count: 3 },
    });
    const dropped = await create(`/v1/achievements/${goal.id}/quests`, {
      title: 'Dropped',
      type: 'one_time',
      size: 'S',
    });
    await create(`/v1/quests/${dropped.id}/check-ins`, { local_date: TODAY });
    const droppedUrl = `/v1/quests/${dropped.id}`;
    await must(200, call('DELETE', droppedUrl, user.token, undefined, await etagOf(droppedUrl)));
    await create(`/v1/quests/${first.id}/check-ins`, { local_date: TODAY, note: 'Felt good' });
    await create(`/v1/quests/${distance.id}/check-ins`, { local_date: TODAY, value: '12.5', note: 'Long run' });
    await create(`/v1/achievements/${goal.id}/gambles`, {});

    const exported = await call('GET', '/v1/me/export', user.token);
    if (exported.statusCode !== 200) throw new Error(`export answered ${String(exported.statusCode)}`);
    document = exported.json<ExportDocument>();
  }

  /** The user's rows of a table as PostgreSQL renders them in JSON. */
  const storedRows = async (table: string): Promise<Row[]> => {
    const { sql } = ctx.admin;
    const rows =
      table === 'users'
        ? await sql<{ row: Row }[]>`select to_jsonb(t) as row from users t where id = ${user.userId}`
        : await sql<{ row: Row }[]>`select to_jsonb(t) as row from ${sql(table)} t where user_id = ${user.userId}`;
    return rows.map(({ row }) => row);
  };
  /** The stored value as the export must show it: decrypted, and timestamps as instants. */
  const sameValue = async (exported: unknown, stored: unknown, column: string, rowId: string): Promise<boolean> => {
    if (column.endsWith('_enc') && typeof stored === 'string') {
      const plain = await ctx.decrypt(user.userId, rowId, column, Buffer.from(stored.slice(2), 'hex'));
      return exported === plain;
    }
    if (typeof stored === 'string' && TIMESTAMP.test(stored)) {
      return typeof exported === 'string' && Date.parse(exported) === Date.parse(stored);
    }
    return isDeepStrictEqual(exported, stored);
  };

  beforeAll(async () => {
    ctx = await startAccountsApp();
    ctx.clock.set(START);
    inventory = loadInventory();
    await seed();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('has a section for every table with exported columns, and only for those', () => {
    const exportedTables = Object.keys(inventory.tables).filter(
      (table) => exportedColumns(inventory, table).length > 0,
    );

    expect(exportedTables.sort()).toEqual(Object.keys(SECTIONS).sort());
  });

  it('lists in every record exactly the included columns: none missing, none excluded', () => {
    for (const [table, section] of Object.entries(SECTIONS)) {
      const records = section(document);
      const expected = [...exportedColumns(inventory, table).map(keyOf), ...(NESTED[table] ?? [])].sort();

      expect(records.length, table).toBeGreaterThan(0);
      for (const record of records) expect(Object.keys(record).sort(), table).toEqual(expected);
    }
  });

  it('gives every included column its stored value, decrypted, for every row of the account', async () => {
    for (const [table, section] of Object.entries(SECTIONS)) {
      const byId = new Map(section(document).map((record) => [record['id'], record]));
      const stored = await storedRows(table);

      expect([...byId.keys()].sort(), table).toEqual(stored.map((row) => row['id']).sort());
      for (const row of stored) {
        const record = byId.get(row['id']) ?? {};
        for (const column of exportedColumns(inventory, table)) {
          const matches = await sameValue(record[keyOf(column)], row[column], column, String(row['id']));
          expect(matches, `${table}.${column}: ${JSON.stringify(record[keyOf(column)])}`).toBe(true);
        }
      }
    }
  });

  it('fills every encrypted column somewhere, so each one was decrypted at least once', async () => {
    for (const table of Object.keys(SECTIONS)) {
      const stored = await storedRows(table);
      for (const column of exportedColumns(inventory, table).filter((name) => name.endsWith('_enc'))) {
        expect(
          stored.some((row) => row[column] !== null),
          `${table}.${column}`,
        ).toBe(true);
      }
    }
  });

  it('shows the account as of now: a gamble whose target date passed is exported as lost [A-21]', async () => {
    const other = await goalUser(ctx);
    const token = other.token;
    await ctx.admin.sql`
      insert into xp_events (id, user_id, kind, amount, local_date, created_at)
      values (${randomUUID()}, ${other.userId}, 'quest_completed', 1000, ${TODAY}, ${ctx.clock.now()})`;
    const post = async (url: string, body: unknown) => (await call('POST', url, token, body)).json<{ id: string }>();
    const bet = await post('/v1/achievements', { title: 'Bet', target_date: '2026-10-30' });
    await post(`/v1/achievements/${bet.id}/quests`, { title: 'Never done', type: 'one_time', size: 'M' });
    const gamble = await post(`/v1/achievements/${bet.id}/gambles`, {});
    ctx.clock.set('2026-10-31T12:00:00Z');
    const fresh = await ctx.post('/v1/auth/login', { email: other.email, password: TEST_PASSWORD, client: 'ios' });

    const response = await call('GET', '/v1/me/export', fresh.json<{ access_token: string }>().access_token);

    const [exportedBet] = response.json<ExportDocument>().achievements;
    expect(exportedBet?.gambles).toMatchObject([{ id: gamble.id, status: 'lost', loss_reason: 'target_date_passed' }]);
    ctx.clock.set(START);
  });

  it('reads an archive of 1 001 achievements in batches, each with its quest and check-in [Q-40]', async () => {
    const [key] = await ctx.admin.sql<{ wrapped_dek: Buffer; kek_id: string; kek_version: number }[]>`
      select wrapped_dek, kek_id, kek_version from user_keys where user_id = ${user.userId}`;
    const wrapped = {
      blob: key?.wrapped_dek ?? Buffer.alloc(0),
      kekId: key?.kek_id ?? '',
      kekVersion: key?.kek_version ?? 0,
    };
    const now = ctx.clock.now();
    const rows = await ctx.dataKeys.withKey(user.userId, wrapped, (dataKey) =>
      Promise.resolve(
        Array.from({ length: 1001 }, (_, index) => {
          const [achievementId, questId] = [randomUUID(), randomUUID()];
          const seal = (recordId: string, value: string) =>
            encryptText(dataKey, { userId: user.userId, recordId, field: 'title_enc' }, value);
          const common = { user_id: user.userId, dek_version: 1, created_at: now };
          return {
            achievement: {
              ...common,
              id: achievementId,
              title_enc: seal(achievementId, `Old goal ${String(index)}`),
              status: 'completed',
              updated_at: now,
              completed_at: now,
              execution_score: 80,
              rank: 'gold',
            },
            quest: {
              ...common,
              id: questId,
              achievement_id: achievementId,
              position: 0,
              type: 'one_time',
              size: 'S',
              title_enc: seal(questId, `Old step ${String(index)}`),
              completed_at: now,
              updated_at: now,
            },
            checkIn: {
              ...common,
              id: randomUUID(),
              quest_id: questId,
              local_date: TODAY,
              attempt: 1,
              counts_for_progress: true,
            },
          };
        }),
      ),
    );
    const { sql } = ctx.admin;
    await sql`insert into achievements ${sql(rows.map((row) => row.achievement))}`;
    await sql`insert into quests ${sql(rows.map((row) => row.quest))}`;
    await sql`insert into check_ins ${sql(rows.map((row) => row.checkIn))}`;
    ctx.clock.advance({ minutes: 1 });

    const response = await call('GET', '/v1/me/export', user.token);

    const archive = response
      .json<ExportDocument>()
      .achievements.filter((achievement) => String(achievement['title']).startsWith('Old goal'));
    expect(archive).toHaveLength(1001);
    expect(
      archive.every((achievement) => achievement.quests.length === 1 && achievement.quests[0]?.check_ins.length === 1),
    ).toBe(true);
    expect(new Set(archive.map((achievement) => achievement.quests[0]?.['title'])).size).toBe(1001);
  });
});
