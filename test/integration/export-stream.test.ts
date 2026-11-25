import { randomUUID } from 'node:crypto';
import { get } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exportText } from '../../src/modules/privacy/export-document.ts';
import { EXPORT_READ_SIZES, exportSource, type ExportReadSizes } from '../../src/modules/privacy/export-source.ts';
import { createDatabaseClient, type DatabaseClient } from '../../src/platform/db/client.ts';
import { createDatabase, type Database } from '../../src/platform/db/database.ts';
import { startAccountsApp, type AccountsApp } from '../helpers/accounts-app.ts';
import { contractInject } from '../helpers/contract.ts';
import { bearer, createAchievement, goalUser, type GoalUser } from '../helpers/goals.ts';
import { LogCapture } from '../helpers/log-capture.ts';

const NOW = '2026-11-25T08:00:00Z';
const TODAY = '2026-11-25';

/**
 * The export is read in bounded parts and sent as they arrive (D-09): an account of any size costs the server and
 * the database one part at a time. What the parts hold is checked in `test/privacy/export.test.ts`.
 */
describe('the export is sent as it is read [R-PRIV-05, D-09]', () => {
  let ctx: AccountsApp;
  let client: DatabaseClient;
  let db: Database;
  const logs = new LogCapture();
  /** The log lines about failures, without what differs from run to run. */
  const failures = () =>
    logs
      .records()
      .filter((record) => record['level'] === 'error')
      .map(({ msg, err }) => ({ msg, err }));

  const exportOf = (user: GoalUser) => ({ method: 'GET' as const, url: '/v1/me/export', headers: bearer(user.token) });
  const created = async (url: string, user: GoalUser, body: unknown): Promise<string> => {
    const response = await ctx.post(url, body, { ...bearer(user.token), 'idempotency-key': randomUUID() });
    if (response.statusCode !== 201) throw new Error(`${url} answered ${String(response.statusCode)}`);
    return response.json<{ id: string }>().id;
  };
  /** An achievement with a daily habit and `checkIns` check-ins of today, each with a note of 400 characters. */
  const goalWith = async (user: GoalUser, title: string, checkIns: number): Promise<string> => {
    const achievementId = (await createAchievement(ctx, user.token, { title })).json<{ id: string }>().id;
    const questId = await created(`/v1/achievements/${achievementId}/quests`, user, {
      title: `${title}: every day`,
      type: 'habit',
      size: 'S',
      habit: { period: 'day', times_per_period: 50, period_count: 7 },
    });
    for (let index = 0; index < checkIns; index += 1) {
      await created(`/v1/quests/${questId}/check-ins`, user, {
        local_date: TODAY,
        note: `${String(index)} `.padEnd(400, 'n'),
      });
      // Three check-ins a second: an order by time that is not the order of their random IDs, and ties as well.
      if (index % 3 === 2) ctx.clock.advance({ seconds: 1 });
    }
    return questId;
  };
  const exportEvents = async (user: GoalUser): Promise<number> => {
    const [row] = await ctx.admin.sql<{ count: number }[]>`
      select count(*)::int as count from audit_events
      where user_id = ${user.userId} and event_type = 'export_requested'`;
    return row?.count ?? 0;
  };
  /** The document as its reads write it, without a request. */
  const written = async (user: GoalUser, sizes: ExportReadSizes = EXPORT_READ_SIZES): Promise<string> => {
    let text = '';
    const source = exportSource({ db, dataKeys: ctx.dataKeys }, user.userId, sizes);
    for await (const piece of exportText(source, ctx.clock.now())) text += piece;
    return text;
  };

  beforeAll(async () => {
    ctx = await startAccountsApp({ logCapture: logs });
    ctx.clock.set(NOW);
    client = createDatabaseClient({ url: ctx.database.urls.app, applicationName: 'questline-test' });
    db = createDatabase(client);
  });

  afterAll(async () => {
    await client.close();
    await ctx.close();
  });

  it('answers with the document its reads write, without a length, as a file no cache may keep', async () => {
    const user = await goalUser(ctx);
    await goalWith(user, 'Sleep better', 3);

    const response = await contractInject(ctx.app, exportOf(user));

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(await written(user));
    expect(response.json()).toMatchObject({ format: 'questline-export', account: { id: user.userId } });
    expect(response.headers['content-length']).toBeUndefined();
    expect(response.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-disposition']).toBe('attachment; filename="questline-export.json"');
  });

  it('pages through one quest’s check-ins and one achievement’s gambles when they exceed a read, ties included', async () => {
    const user = await goalUser(ctx);
    // Seven check-ins on one quest and five gambles on its achievement, each kind recorded at one instant.
    const questId = await goalWith(user, 'Busy', 7);
    const [quest] = await ctx.admin.sql<{ achievement_id: string }[]>`
      select achievement_id from quests where id = ${questId}`;
    const at = ctx.clock.now();
    const lost = Array.from({ length: 5 }, () => ({
      id: randomUUID(),
      user_id: user.userId,
      achievement_id: quest?.achievement_id ?? '',
      attempt: 1,
      stake: 10,
      status: 'lost',
      loss_reason: 'paused',
      placed_at: at,
      settled_at: at,
    }));
    await ctx.admin.sql`insert into gambles ${ctx.admin.sql(lost)}`;
    await goalWith(user, 'Quiet', 1);

    const whole = await written(user);

    for (const sizes of [
      { rows: 1, achievements: 1 },
      { rows: 2, achievements: 1 },
      { rows: 3, achievements: 2 },
      { rows: 7, achievements: 1 },
    ]) {
      expect(await written(user, sizes)).toBe(whole);
    }
    const busy = (
      JSON.parse(whole) as {
        achievements: {
          title: string;
          gambles: unknown[];
          quests: { check_ins: { note: string; created_at: string }[] }[];
        }[];
      }
    ).achievements.find((achievement) => achievement.title === 'Busy');
    expect([busy?.gambles.length, busy?.quests[0]?.check_ins.length]).toEqual([5, 7]);
    // In the order they were made: the notes count up.
    expect(
      busy?.quests[0]?.check_ins.map((checkIn) => Number.parseInt(checkIn.note, 10)).sort((a, b) => a - b),
    ).toEqual([0, 1, 2, 3, 4, 5, 6]);
    const times = busy?.quests[0]?.check_ins.map((checkIn) => checkIn.created_at) ?? [];
    expect(times).toEqual([...times].sort());
    expect(new Set(times).size).toBe(3);
  });

  it('answers 500 and sends nothing of the document when its first reads fail, and the export still counts', async () => {
    const user = await goalUser(ctx);
    // Without a quest, so nothing reads the achievement before the document does (A-21 syncs habits and gambles).
    await createAchievement(ctx, user.token, { title: 'Read more' });
    await ctx.admin.sql`update achievements set title_enc = ${Buffer.from([1, 2, 3])} where user_id = ${user.userId}`;

    // Not through the contract check: the contract documents no 500, as for every operation.
    const response = await ctx.app.inject(exportOf(user));

    expect(response.statusCode).toBe(500);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(response.body).not.toContain('questline-export');
    expect(failures()).toEqual([{ msg: 'request failed', err: { name: 'DecryptionError' } }]);
    // The request was admitted before its document failed: the event is stored, and it is one of the two.
    expect(await exportEvents(user)).toBe(1);
  });

  it('cuts the connection when a read fails after the document began, and the export still counts [D-09]', async () => {
    const user = await goalUser(ctx);
    // The first read of achievements takes 20: one with 50 check-ins of 400 characters — more than the first piece of
    // the document — and 19 more. The damaged one comes with the second read.
    await goalWith(user, 'First', 50);
    ctx.clock.advance({ seconds: 1 });
    for (let index = 0; index < 19; index += 1) await createAchievement(ctx, user.token, { title: 'Between' });
    ctx.clock.advance({ seconds: 1 });
    const last = (await createAchievement(ctx, user.token, { title: 'Last' })).json<{ id: string }>().id;
    await ctx.admin.sql`update achievements set title_enc = ${Buffer.from([1, 2, 3])} where id = ${last}`;

    const response = ctx.app.inject(exportOf(user));

    await expect(response).rejects.toThrow('response destroyed before completion');
    expect(await exportEvents(user)).toBe(1);
    // No problem document can follow a status that was already sent, so the failure is logged where it happened:
    // by its class alone, like every error.
    expect(failures().at(-1)).toEqual({ msg: 'export interrupted', err: { name: 'DecryptionError' } });
    expect(failures().filter((failure) => failure.msg === 'export interrupted')).toHaveLength(1);
  });

  it('leaves a download the client broke off without a failure in the log, and it counts [D-09]', async () => {
    const user = await goalUser(ctx);
    // A document of some 20 MB — 2 000 audit events of 10 000 characters each: more than a connection holds unread,
    // so the server is still writing when the client leaves.
    await ctx.admin.sql`
      insert into audit_events (id, user_id, event_type, outcome, metadata, created_at)
      select gen_random_uuid(), ${user.userId}, 'login_succeeded', 'success',
             jsonb_build_object('filler', repeat('f', 10000)), ${NOW}::timestamptz + n * interval '1 millisecond'
      from generate_series(1, 2000) as n`;
    const address = await ctx.app.listen({ host: '127.0.0.1', port: 0 });
    const errorsBefore = failures().length;

    const received = await new Promise<number>((resolve, reject) => {
      get(`${address}/v1/me/export`, { headers: bearer(user.token) }, (response) => {
        response.once('data', (chunk: Buffer) => {
          response.destroy();
          resolve(chunk.length);
        });
      }).once('error', reject);
    });
    // A whole export afterwards: by its end the server has long dealt with the broken one.
    const second = await ctx.app.inject(exportOf(user));
    const third = await ctx.app.inject(exportOf(user));

    expect(second.body.length).toBeGreaterThan(20_000_000);
    expect(received).toBeLessThan(second.body.length / 10);
    expect(failures()).toHaveLength(errorsBefore);
    // The one that was broken off was asked for all the same: it is one of the two.
    expect(third.statusCode).toBe(429);
    expect(await exportEvents(user)).toBe(2);
  });

  it('has an index for the order of every list it reads in pages, so each page is one range scan', async () => {
    const indexes = await ctx.admin.sql<{ definition: string }[]>`
      select indexdef as definition from pg_indexes where schemaname = 'public'`;
    const keys = indexes.map(({ definition }) => definition.replace(/^.* USING btree /, ''));

    expect(keys).toEqual(
      expect.arrayContaining([
        '(user_id, granted_at, id)', // consents
        '(user_id, created_at, id)', // sessions, achievements, xp_events (one each)
        '(user_id, awarded_at, id)', // badges
        '(achievement_id, placed_at, id)', // gambles
        '(quest_id, created_at, id)', // check-ins
        '(user_id, created_at)', // audit events
      ]),
    );
    expect(keys.filter((key) => key === '(user_id, created_at, id)')).toHaveLength(3);
  });
});
