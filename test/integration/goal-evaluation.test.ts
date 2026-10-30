import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { goalJobs, type GoalEvaluationOptions } from '../../src/modules/goals/daily-evaluation.ts';
import { createDatabaseClient, type DatabaseClient } from '../../src/platform/db/client.ts';
import { createDatabase, inTransaction, type Database } from '../../src/platform/db/database.ts';
import { createLogger } from '../../src/platform/logging/logger.ts';
import { startAccountsApp, type AccountsApp } from '../helpers/accounts-app.ts';
import { bearer, createAchievement, goalUser, type GoalUser } from '../helpers/goals.ts';
import { LogCapture } from '../helpers/log-capture.ts';

const START = '2026-10-29T12:00:00Z';
const TODAY = '2026-10-29'; // in Europe/Zurich, a Thursday

/**
 * The daily goal evaluation in the worker (`src/modules/goals/daily-evaluation.ts`) with the worker role: after each
 * user's local midnight, what time alone changes is stored without any request.
 */
describe('daily goal evaluation [A-20, A-21, R-QST-04, R-GMB-03, ADR-0011]', () => {
  let ctx: AccountsApp;
  let workerClient: DatabaseClient;
  let worker: Database;
  let logs: LogCapture;

  const achievementOf = async (user: GoalUser, body: Record<string, unknown> = {}) =>
    (await createAchievement(ctx, user.token, { title: 'Goal', ...body })).json<{ id: string }>().id;
  const createQuest = async (user: GoalUser, achievementId: string, body: Record<string, unknown>) =>
    (
      await ctx.post(
        `/v1/achievements/${achievementId}/quests`,
        { title: 'Quest', size: 'M', ...body },
        { ...bearer(user.token), 'idempotency-key': randomUUID() },
      )
    ).json<{ id: string }>().id;
  const daily = { type: 'habit', habit: { period: 'day', times_per_period: 1, period_count: 3 } };
  /** A user with an achievement that has a daily habit started today. */
  const habitUser = async () => {
    const user = await goalUser(ctx);
    const achievementId = await achievementOf(user);
    return { user, achievementId, questId: await createQuest(user, achievementId, daily) };
  };
  const placeGamble = async (user: GoalUser, achievementId: string) => {
    await ctx.admin.sql`
      insert into xp_events (id, user_id, kind, amount, local_date, created_at)
      values (${randomUUID()}, ${user.userId}, 'quest_completed', 250, ${TODAY}, ${ctx.clock.now()})`;
    const response = await ctx.post(
      `/v1/achievements/${achievementId}/gambles`,
      {},
      {
        ...bearer(user.token),
        'idempotency-key': randomUUID(),
      },
    );
    if (response.statusCode !== 201) throw new Error(`gamble refused: ${String(response.statusCode)}`);
    return response.json<{ id: string }>().id;
  };
  const run = (options: GoalEvaluationOptions = {}) => {
    const [job] = goalJobs({ db: worker, dataKeys: ctx.dataKeys, clock: ctx.clock, logger }, options);
    if (job === undefined) throw new Error('no goal job');
    return inTransaction(worker, (tx) => job.run(tx, ctx.clock.now()));
  };
  const at = (instant: string) => {
    ctx.clock.set(instant);
  };
  const evaluation = async (userId: string) =>
    (
      await ctx.admin.sql<{ evaluated_on: string; due_at: Date }[]>`
        select evaluated_on::text as evaluated_on, due_at from goal_evaluations where user_id = ${userId}`
    )[0];
  const questRow = async (questId: string) =>
    (
      await ctx.admin.sql<{ needs_restart: boolean; reset_count: number }[]>`
        select needs_restart, reset_count from quests where id = ${questId}`
    )[0];
  const gambleRow = async (gambleId: string) =>
    (
      await ctx.admin.sql<{ status: string; loss_reason: string | null }[]>`
        select status, loss_reason from gambles where id = ${gambleId}`
    )[0];
  let logger: ReturnType<typeof createLogger>;

  beforeAll(async () => {
    ctx = await startAccountsApp();
    workerClient = createDatabaseClient({ url: ctx.database.urls.worker, applicationName: 'questline-test' });
    worker = createDatabase(workerClient);
  });

  afterAll(async () => {
    await workerClient.close();
    await ctx.close();
  });

  beforeEach(async () => {
    at(START);
    logs = new LogCapture();
    logger = createLogger({ service: 'questline-worker', level: 'info' }, logs.stream);
    // Each test sees only its own users: the earlier ones are evaluated through to the far future.
    await ctx.admin.sql`
      insert into goal_evaluations (user_id, evaluated_on, due_at)
      select id, '2099-12-31', '2099-12-31T23:00:00Z' from users
      on conflict (user_id) do update set evaluated_on = excluded.evaluated_on, due_at = excluded.due_at`;
  });

  it('resets a habit whose period was missed and loses the pending gamble after the local midnight, without any request [R-QST-04, R-GMB-03]', async () => {
    const user = await goalUser(ctx);
    const achievementId = await achievementOf(user, { target_date: '2026-11-30' });
    const questId = await createQuest(user, achievementId, daily);
    const gambleId = await placeGamble(user, achievementId);
    expect(await run()).toBe(1);

    at('2026-10-30T23:00:00Z');
    const evaluated = await run();

    expect(evaluated).toBe(1);
    expect(await questRow(questId)).toEqual({ needs_restart: true, reset_count: 1 });
    expect(await gambleRow(gambleId)).toEqual({ status: 'lost', loss_reason: 'habit_reset' });
    expect(await evaluation(user.userId)).toEqual({
      evaluated_on: '2026-10-31',
      due_at: new Date('2026-10-31T23:00:00Z'),
    });
  });

  it('evaluates a user once per local day, from the local midnight on [A-20, ADR-0011]', async () => {
    const { user } = await habitUser();

    expect(await run()).toBe(1);
    expect(await evaluation(user.userId)).toEqual({ evaluated_on: TODAY, due_at: new Date('2026-10-29T23:00:00Z') });
    at('2026-10-29T22:59:59Z');
    expect(await run()).toBe(0);
    at('2026-10-29T23:00:00Z');
    expect(await run()).toBe(1);
    expect(await evaluation(user.userId)).toEqual({
      evaluated_on: '2026-10-30',
      due_at: new Date('2026-10-30T23:00:00Z'),
    });
  });

  it('loses a gamble once its target date has passed in the account’s time zone, and not on the date itself [A-20, R-GMB-03]', async () => {
    const user = await goalUser(ctx);
    const achievementId = await achievementOf(user, { target_date: '2026-10-30' });
    await createQuest(user, achievementId, { type: 'one_time' });
    const gambleId = await placeGamble(user, achievementId);

    at('2026-10-30T22:59:59Z');
    expect(await run()).toBe(1);
    expect(await gambleRow(gambleId)).toEqual({ status: 'pending', loss_reason: null });
    at('2026-10-30T23:00:00Z');
    expect(await run()).toBe(1);

    expect(await gambleRow(gambleId)).toEqual({ status: 'lost', loss_reason: 'target_date_passed' });
  });

  it('leaves out users whose goals time cannot change: one-time quests only, paused or completed achievements [A-21]', async () => {
    const once = await goalUser(ctx);
    await createQuest(once, await achievementOf(once), { type: 'one_time' });
    const paused = await habitUser();
    await ctx.admin.sql`update achievements set status = 'paused' where id = ${paused.achievementId}`;

    expect(await run()).toBe(0);
    expect([await evaluation(once.userId), await evaluation(paused.user.userId)]).toEqual([undefined, undefined]);
  });

  it('takes at most a batch of users per run, and the next runs the rest', async () => {
    for (let count = 0; count < 3; count += 1) await habitUser();

    expect([await run({ batchSize: 2 }), await run({ batchSize: 2 }), await run({ batchSize: 2 })]).toEqual([2, 1, 0]);
  });

  it('serves those never evaluated first, then the longest waiting', async () => {
    const waiting = await habitUser();
    const longer = await habitUser();
    const never = await habitUser();
    await ctx.admin.sql`
      insert into goal_evaluations (user_id, evaluated_on, due_at)
      values (${waiting.user.userId}, '2026-10-28', '2026-10-28T23:00:00Z'),
             (${longer.user.userId}, '2026-10-27', '2026-10-27T23:00:00Z')`;

    const order: string[] = [];
    for (let turn = 0; turn < 3; turn += 1) {
      await run({ batchSize: 1 });
      for (const [name, id] of [
        ['never', never.user.userId],
        ['longer', longer.user.userId],
        ['waiting', waiting.user.userId],
      ] as const) {
        if ((await evaluation(id))?.evaluated_on === TODAY && !order.includes(name)) order.push(name);
      }
    }

    expect(order).toEqual(['never', 'longer', 'waiting']);
  });

  it('starts no further user once its time budget is spent', async () => {
    for (let count = 0; count < 2; count += 1) await habitUser();

    expect([await run({ budgetMs: 0 }), await run({ budgetMs: 0 }), await run({ budgetMs: 0 })]).toEqual([1, 1, 0]);
  });

  it('goes on after a user whose evaluation fails, who stays due, and logs no user data [R-LOG-02]', async () => {
    const broken = await habitUser();
    const fine = await habitUser();
    await ctx.admin.sql`delete from user_keys where user_id = ${broken.user.userId}`;

    expect(await run()).toBe(1);

    expect(await evaluation(fine.user.userId)).toMatchObject({ evaluated_on: TODAY });
    expect(await evaluation(broken.user.userId)).toBeUndefined();
    expect(logs.records()).toContainEqual(
      expect.objectContaining({ level: 'error', msg: 'goal evaluation failed', job: 'evaluate_goals' }),
    );
    expect(logs.text).not.toContain(broken.user.userId);
  });

  it('lets the worker change only the rows of the user whose context it set [RLS, T-01]', async () => {
    const owner = await habitUser();
    const other = await habitUser();

    const changed = await workerClient.sql.begin(async (sql) => {
      await sql`select set_config('app.user_id', ${owner.user.userId}, true)`;
      const quests = await sql`update quests set position = 7 where id = ${other.questId} returning id`;
      const read = await sql`select id from quests where id = ${other.questId}`;
      return { updated: quests.length, read: read.length };
    });

    expect(changed).toEqual({ updated: 0, read: 1 });
    await expect(
      workerClient.sql.begin(async (sql) => {
        await sql`select set_config('app.user_id', ${owner.user.userId}, true)`;
        await sql`insert into xp_events (id, user_id, kind, amount, local_date, created_at)
          values (${randomUUID()}, ${other.user.userId}, 'quest_completed', 10, ${TODAY}, now())`;
      }),
    ).rejects.toMatchObject({ code: '42501' });
  });
});
