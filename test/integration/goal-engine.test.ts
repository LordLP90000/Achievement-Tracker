import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkInsRepository } from '../../src/modules/check-ins/repository.ts';
import { syncAchievement, withGoals, type GoalDependencies } from '../../src/modules/goals/engine.ts';
import { questsRepository, type NewQuest } from '../../src/modules/quests/repository.ts';
import { createDatabaseClient, type DatabaseClient } from '../../src/platform/db/client.ts';
import { createDatabase } from '../../src/platform/db/database.ts';
import { startAccountsApp, type AccountsApp } from '../helpers/accounts-app.ts';
import { createAchievement, goalUser } from '../helpers/goals.ts';

const TODAY = '2026-10-29'; // the fake clock's day in Europe/Zurich, a Thursday
const START = '2026-10-29T12:00:00Z';

type QuestSpec = Partial<Omit<NewQuest, 'achievementId' | 'position' | 'prerequisiteQuestId'>> & {
  /** Index of an earlier quest of the same goal. */
  readonly prerequisite?: number;
};

const weekly = (startDate: string) => ({
  type: 'habit' as const,
  habit: { period: 'week' as const, timesPerPeriod: 3, periodCount: 4, startDate, weekStart: 'monday' as const },
});

/**
 * The goal engine (`src/modules/goals/engine.ts`) against PostgreSQL: evaluation, lazy resets, reconciliation and
 * its persistence, under the user's lock. Quests and check-ins are written through their repositories here.
 */
describe('goal engine [R-XP-01, R-ACH-04/05, R-QST-04, R-GMB-02/03, Q-38, A-21, T-06]', () => {
  let ctx: AccountsApp;
  let client: DatabaseClient;
  let deps: GoalDependencies;

  /** A consenting user with an achievement and the given quests, in order. */
  async function setUp(quests: readonly QuestSpec[], achievement: Record<string, unknown> = { title: 'Goal' }) {
    const { userId, token } = await goalUser(ctx);
    const created = await createAchievement(ctx, token, achievement);
    const achievementId = created.json<{ id: string }>().id;
    const questIds = await withGoals(deps, userId, async (scope) => {
      const repository = questsRepository(scope.tx, userId, scope.dataKey);
      const ids: string[] = [];
      for (const [position, { prerequisite, ...spec }] of quests.entries()) {
        const quest = await repository.insert(
          {
            achievementId,
            position,
            type: 'one_time',
            size: 'M',
            isRequired: true,
            title: `Quest ${String(position)}`,
            notes: null,
            habit: null,
            target: null,
            ...spec,
            prerequisiteQuestId: prerequisite === undefined ? null : (ids[prerequisite] ?? null),
          },
          scope.now,
        );
        ids.push(quest.id);
      }
      return ids;
    });
    return { userId, achievementId, questIds, quest: (index: number) => questIds[index] ?? '' };
  }

  const checkIn = (userId: string, questId: string, value: string | null = null, localDate = TODAY) =>
    withGoals(deps, userId, (scope) =>
      checkInsRepository(scope.tx, userId, scope.dataKey).insert(
        { questId, localDate, attempt: 1, countsForProgress: true, value, note: null },
        scope.now,
      ),
    );
  const sync = (userId: string, achievementId: string) =>
    withGoals(deps, userId, (scope) => syncAchievement(scope, achievementId));
  /** In writing order: by time, then by transaction (the fake clock stands still), then by kind and amount. */
  const ledger = async (userId: string) =>
    (
      await ctx.admin.sql<{ kind: string; amount: number }[]>`
        select kind, amount::int as amount from xp_events where user_id = ${userId}
        order by created_at, xmin::text::bigint, kind, amount`
    ).map((event) => ({ ...event }));
  const achievementRow = async (achievementId: string) =>
    ({
      ...(
        await ctx.admin.sql<Record<string, unknown>[]>`
          select status, rank, execution_score::float as score, completed_at, version
          from achievements where id = ${achievementId}`
      )[0],
    }) as Record<string, unknown>;
  const questRow = async (questId: string) =>
    ({
      ...(
        await ctx.admin.sql<Record<string, unknown>[]>`
          select needs_restart, reset_count, habit_best_streak, habit_start_date::text as start_date,
                 habit_week_start as week_start, completed_at, version
          from quests where id = ${questId}`
      )[0],
    }) as Record<string, unknown>;
  const badges = async (achievementId: string) =>
    (await ctx.admin.sql<{ rank: string }[]>`select rank from badges where achievement_id = ${achievementId}`).map(
      (badge) => badge.rank,
    );
  /** XP the user already has, as earlier achievements would have left it. */
  const giveXp = (userId: string, amount: number) =>
    ctx.admin.sql`
      insert into xp_events (id, user_id, kind, amount, local_date, created_at)
      values (${randomUUID()}, ${userId}, 'quest_completed', ${amount}, ${TODAY}, ${ctx.clock.now()})`;
  const pendingGamble = async (userId: string, achievementId: string, stake: number) => {
    const id = randomUUID();
    await ctx.admin.sql`
      insert into gambles (id, user_id, achievement_id, attempt, stake, status, placed_at)
      values (${id}, ${userId}, ${achievementId}, 1, ${stake}, 'pending', ${ctx.clock.now()})`;
    return id;
  };
  const gambleRow = async (gambleId: string) =>
    ({
      ...(
        await ctx.admin.sql<Record<string, unknown>[]>`
          select status, loss_reason, settled_at from gambles where id = ${gambleId}`
      )[0],
    }) as Record<string, unknown>;

  beforeAll(async () => {
    ctx = await startAccountsApp();
    client = createDatabaseClient({
      url: ctx.database.urls.app,
      applicationName: 'questline-test',
      maxConnections: 12,
    });
    deps = { db: createDatabase(client), dataKeys: ctx.dataKeys, clock: ctx.clock };
  });

  afterAll(async () => {
    await client.close();
    await ctx.close();
  });

  beforeEach(() => {
    ctx.clock.set(START);
  });

  it('shows a new goal as it is: nothing complete, nothing credited', async () => {
    const goal = await setUp([{ size: 'M' }, { size: 'L', isRequired: false }]);

    const result = await sync(goal.userId, goal.achievementId);

    expect(result?.view).toMatchObject({ progress: 0, xpRequiredTotal: 25, xpEarned: 0 });
    expect(result?.view.quests.map((quest) => quest.evaluation.state)).toEqual(['available', 'available']);
    expect(result?.outcome?.events).toEqual([]);
    expect(await ledger(goal.userId)).toEqual([]);
  });

  it('answers nothing for an achievement of another user [R-AUTHZ-02]', async () => {
    const goal = await setUp([{}]);
    const intruder = await goalUser(ctx);

    expect(await sync(intruder.userId, goal.achievementId)).toBeUndefined();
    expect(await sync(goal.userId, randomUUID())).toBeUndefined();
  });

  it('leaves an achievement without quests at 0 with nothing to reconcile [A-17]', async () => {
    const goal = await setUp([]);

    const result = await sync(goal.userId, goal.achievementId);

    expect(result?.view).toMatchObject({ quests: [], progress: 0, xpRequiredTotal: 0, xpEarned: 0 });
    expect(result?.outcome).toMatchObject({ events: [], unlock: null, relocked: false, gamble: null });
  });

  it('completes a quest with its counting check-in, credits its XP once and unlocks the achievement [R-XP-01, R-ACH-04]', async () => {
    const goal = await setUp([{ size: 'M' }]);
    await checkIn(goal.userId, goal.quest(0));

    const result = await sync(goal.userId, goal.achievementId);

    expect(await ledger(goal.userId)).toEqual([{ kind: 'quest_completed', amount: 25 }]);
    expect(result).toMatchObject({ totalXp: 25, outcome: { unlock: { score: 100, rank: 'champion' } } });
    expect(result?.view).toMatchObject({ progress: 1, xpEarned: 25, record: { status: 'completed', version: 2 } });
    expect(await achievementRow(goal.achievementId)).toMatchObject({
      status: 'completed',
      rank: 'champion',
      score: 100,
      completed_at: ctx.clock.now(),
      version: 2,
    });
    expect(await badges(goal.achievementId)).toEqual(['champion']);
    expect(await questRow(goal.quest(0))).toMatchObject({ completed_at: ctx.clock.now(), version: 2 });

    // Idempotent: a second look changes nothing.
    await sync(goal.userId, goal.achievementId);
    expect(await ledger(goal.userId)).toEqual([{ kind: 'quest_completed', amount: 25 }]);
    expect(await achievementRow(goal.achievementId)).toMatchObject({ version: 2 });
  });

  it('pays the rank bonus for an unlock at least 7 days after creation, and none before [R-RANK-03, A-34]', async () => {
    const goal = await setUp([{ size: 'M' }]);
    ctx.clock.advance({ days: 7 });
    await checkIn(goal.userId, goal.quest(0), null, '2026-11-05');

    await sync(goal.userId, goal.achievementId);

    expect(await ledger(goal.userId)).toEqual([
      { kind: 'quest_completed', amount: 25 },
      { kind: 'rank_bonus', amount: 25 * 365 },
    ]);
  });

  it('re-locks the achievement when an undo makes a required quest incomplete: XP, bonus, rank and badge go [R-ACH-05, R-RANK-04]', async () => {
    const goal = await setUp([{ size: 'M' }]);
    ctx.clock.advance({ days: 7 });
    const made = await checkIn(goal.userId, goal.quest(0), null, '2026-11-05');
    await sync(goal.userId, goal.achievementId);

    await ctx.admin.sql`delete from check_ins where id = ${made.id}`;
    const result = await sync(goal.userId, goal.achievementId);

    expect(result).toMatchObject({ totalXp: 0, outcome: { relocked: true } });
    expect((await ledger(goal.userId)).slice(2)).toEqual([
      { kind: 'quest_uncompleted', amount: -25 },
      { kind: 'rank_bonus_revoked', amount: -25 * 365 },
    ]);
    expect(await achievementRow(goal.achievementId)).toMatchObject({
      status: 'active',
      rank: null,
      score: null,
      completed_at: null,
    });
    expect(await badges(goal.achievementId)).toEqual([]);
    expect(await questRow(goal.quest(0))).toMatchObject({ completed_at: null });
  });

  it('unlocks without the bonus quests, which never block, and ranks the unlock below Champion [R-ACH-04, R-RANK-02]', async () => {
    const goal = await setUp([{ size: 'M' }, { size: 'S', isRequired: false }]);
    await checkIn(goal.userId, goal.quest(0));

    const result = await sync(goal.userId, goal.achievementId);

    expect(result?.outcome?.unlock).toEqual({ score: 100, rank: 'diamond' });
    expect(result?.view.quests.map((quest) => quest.evaluation.state)).toEqual(['completed', 'available']);
  });

  it('resets a habit whose closed period was missed, once, when it is read [R-QST-04, A-21]', async () => {
    const daily = {
      type: 'habit' as const,
      habit: {
        period: 'day' as const,
        timesPerPeriod: 1,
        periodCount: 3,
        startDate: '2026-10-27',
        weekStart: 'monday' as const,
      },
    };
    const goal = await setUp([weekly('2026-10-12'), daily]);

    const first = await sync(goal.userId, goal.achievementId);
    await sync(goal.userId, goal.achievementId);

    expect(first?.view.quests.map((quest) => quest.evaluation.state)).toEqual(['needs_restart', 'needs_restart']);
    expect(first?.view.quests[0]?.evaluation).toMatchObject({ state: 'needs_restart', progress: 0 });
    expect(first?.view.quests[0]?.record).toMatchObject({ needsRestart: true, resetCount: 1, version: 2 });
    expect(await questRow(goal.quest(0))).toMatchObject({
      needs_restart: true,
      reset_count: 1,
      habit_best_streak: 0,
      version: 2,
    });
    expect(await questRow(goal.quest(1))).toMatchObject({ needs_restart: true, reset_count: 1, week_start: null });
  });

  it('moves a locked habit’s run to the unlock day, so periods missed while locked never reset it [Q-38]', async () => {
    const goal = await setUp([{ size: 'S' }, { ...weekly('2026-10-12'), prerequisite: 0 }]);

    const locked = await sync(goal.userId, goal.achievementId);
    expect(locked?.view.quests[1]?.evaluation).toMatchObject({ state: 'locked', reset: null });

    await checkIn(goal.userId, goal.quest(0));
    const unlocked = await sync(goal.userId, goal.achievementId);

    expect(unlocked?.view.quests[1]?.evaluation).toMatchObject({
      state: 'available',
      currentPeriod: { start: TODAY, end: '2026-11-08' },
    });
    expect(await questRow(goal.quest(1))).toMatchObject({
      start_date: TODAY,
      week_start: 'monday',
      needs_restart: false,
      reset_count: 0,
    });
  });

  it('measures a target quest by its latest value and credits it once the target is reached [R-QST-05]', async () => {
    const goal = await setUp([{ type: 'target', size: 'L', target: { start: '80', target: '70', unit: 'kg' } }]);
    await checkIn(goal.userId, goal.quest(0), '75.5', '2026-10-27');

    const halfway = await sync(goal.userId, goal.achievementId);
    expect(halfway?.view.quests[0]?.evaluation).toMatchObject({ currentValue: 75_500, progress: 0.45 });

    await checkIn(goal.userId, goal.quest(0), '69.9');
    await sync(goal.userId, goal.achievementId);
    expect(await ledger(goal.userId)).toEqual([{ kind: 'quest_completed', amount: 50 }]);
  });

  it('loses a pending gamble whose target date has passed before anything else, taking at most the XP above the level [R-GMB-03, Q-31]', async () => {
    const goal = await setUp([{}], { title: 'Late', target_date: '2026-10-28' });
    await giveXp(goal.userId, 150);
    const gambleId = await pendingGamble(goal.userId, goal.achievementId, 80);

    const result = await sync(goal.userId, goal.achievementId);

    expect(result?.outcome?.gamble).toMatchObject({ id: gambleId, outcome: 'lost', xpDelta: -50 });
    expect((await ledger(goal.userId)).at(-1)).toEqual({ kind: 'gamble_lost', amount: -50 });
    expect(await gambleRow(gambleId)).toMatchObject({
      status: 'lost',
      loss_reason: 'target_date_passed',
      settled_at: ctx.clock.now(),
    });
  });

  it('loses a pending gamble when a habit of the achievement resets [R-GMB-03]', async () => {
    const goal = await setUp([weekly('2026-10-12')], { title: 'Habit gamble', target_date: '2026-12-31' });
    await giveXp(goal.userId, 150);
    const gambleId = await pendingGamble(goal.userId, goal.achievementId, 30);

    const result = await sync(goal.userId, goal.achievementId);

    expect(result?.outcome?.gamble).toMatchObject({ id: gambleId, outcome: 'lost', xpDelta: -30 });
    expect(await gambleRow(gambleId)).toMatchObject({ status: 'lost', loss_reason: 'habit_reset' });
  });

  it('dates ledger events by the account’s time zone, not UTC [R-XP-01, A-13]', async () => {
    const goal = await setUp([{ size: 'S' }]);
    // 23:30 UTC on 29 October is already 30 October in Zurich.
    ctx.clock.set('2026-10-29T23:30:00Z');
    await checkIn(goal.userId, goal.quest(0), null, '2026-10-30');

    await sync(goal.userId, goal.achievementId);

    const [event] = await ctx.admin.sql<{ local_date: string }[]>`
      select local_date::text from xp_events where user_id = ${goal.userId}`;
    expect(event?.local_date).toBe('2026-10-30');
  });

  it('wins a pending gamble with an unlock on time, paying at most the required XP [R-GMB-02, Q-31]', async () => {
    const goal = await setUp([{ size: 'M' }], { title: 'On time', target_date: '2026-12-31' });
    await giveXp(goal.userId, 150);
    const gambleId = await pendingGamble(goal.userId, goal.achievementId, 40);
    ctx.clock.advance({ days: 7 });
    await checkIn(goal.userId, goal.quest(0), null, '2026-11-05');

    const result = await sync(goal.userId, goal.achievementId);

    expect(result?.outcome?.gamble).toMatchObject({ id: gambleId, outcome: 'won', xpDelta: 25 });
    expect(await gambleRow(gambleId)).toMatchObject({ status: 'won', loss_reason: null });
  });

  it('reverts a won gamble when the winning unlock is undone, taking back what it paid, and wins it again later [R-ACH-05, R-GMB-02]', async () => {
    const goal = await setUp([{ size: 'M' }], { title: 'On time', target_date: '2026-12-31' });
    await giveXp(goal.userId, 150);
    const gambleId = await pendingGamble(goal.userId, goal.achievementId, 40);
    ctx.clock.advance({ days: 7 });
    const made = await checkIn(goal.userId, goal.quest(0), null, '2026-11-05');
    await sync(goal.userId, goal.achievementId);

    await ctx.admin.sql`delete from check_ins where id = ${made.id}`;
    const undone = await sync(goal.userId, goal.achievementId);

    expect(undone?.outcome?.gamble).toMatchObject({ id: gambleId, outcome: 'reverted', xpDelta: -25 });
    expect(await gambleRow(gambleId)).toMatchObject({ status: 'pending', loss_reason: null, settled_at: null });

    await checkIn(goal.userId, goal.quest(0), null, '2026-11-05');
    const again = await sync(goal.userId, goal.achievementId);

    expect(again?.outcome?.gamble).toMatchObject({ id: gambleId, outcome: 'won', xpDelta: 25 });
    const gambleEvents = (await ledger(goal.userId)).filter((event) => event.kind.startsWith('gamble_'));
    expect(gambleEvents).toEqual([
      { kind: 'gamble_won', amount: 25 },
      { kind: 'gamble_reverted', amount: -25 },
      { kind: 'gamble_won', amount: 25 },
    ]);
    expect(again?.totalXp).toBe(150 + 25 + 25 * 365 + 25);
  });

  it('credits XP once when ten requests evaluate the same goal at the same time [T-06]', async () => {
    const goal = await setUp([{ size: 'M' }, { size: 'S', isRequired: false }]);
    await checkIn(goal.userId, goal.quest(0));
    await checkIn(goal.userId, goal.quest(1));

    await Promise.all(Array.from({ length: 10 }, () => sync(goal.userId, goal.achievementId)));

    expect(await ledger(goal.userId)).toEqual([
      { kind: 'quest_completed', amount: 10 },
      { kind: 'quest_completed', amount: 25 },
    ]);
    expect(await badges(goal.achievementId)).toEqual(['champion']);
  });

  it('counts only check-ins of the current attempt: earlier attempts are history [R-ACH-06]', async () => {
    const goal = await setUp([{ size: 'M' }]);
    await checkIn(goal.userId, goal.quest(0));
    // As a pause and a resume leave it (m3-pause-delete): the attempt's XP revoked, the next attempt begun.
    await ctx.admin.sql`update achievements set attempt = 2 where id = ${goal.achievementId}`;

    const result = await sync(goal.userId, goal.achievementId);

    expect(result?.view.quests[0]?.evaluation).toMatchObject({ completed: false, progress: 0 });
    expect(await ledger(goal.userId)).toEqual([]);
  });

  it('shows a paused achievement as reset and changes nothing while it is paused [R-ACH-06]', async () => {
    const goal = await setUp([{ size: 'M' }, weekly('2026-10-12')]);
    await checkIn(goal.userId, goal.quest(0));
    await ctx.admin.sql`update achievements set status = 'paused' where id = ${goal.achievementId}`;

    const result = await sync(goal.userId, goal.achievementId);

    expect(result?.view.quests.map((quest) => quest.evaluation.progress)).toEqual([0, 0]);
    expect(result?.outcome).toBeNull();
    expect(await ledger(goal.userId)).toEqual([]);
    expect(await questRow(goal.quest(1))).toMatchObject({ needs_restart: false, reset_count: 0, version: 1 });
  });

  it('keeps a completed achievement as it was unlocked: a running bonus habit never resets afterwards [R-ACH-07]', async () => {
    const goal = await setUp([{ size: 'M' }, { ...weekly(TODAY), isRequired: false }]);
    await checkIn(goal.userId, goal.quest(0));
    await sync(goal.userId, goal.achievementId);

    ctx.clock.advance({ days: 30 });
    const later = await sync(goal.userId, goal.achievementId);

    expect(later?.view.record.status).toBe('completed');
    expect(later?.view.quests[1]?.evaluation).toMatchObject({ state: 'available', reset: null });
    expect(await questRow(goal.quest(1))).toMatchObject({ needs_restart: false, reset_count: 0, version: 1 });
    expect(await ledger(goal.userId)).toEqual([{ kind: 'quest_completed', amount: 25 }]);
  });

  it('closes periods at midnight in the account’s time zone, not in UTC [A-20, ADR-0011]', async () => {
    const goal = await setUp([weekly('2026-10-26')]);

    // 22:59:59 UTC on Sunday 1 November is 23:59:59 in Zurich: the first week is still open.
    ctx.clock.set('2026-11-01T22:59:59Z');
    const open = await sync(goal.userId, goal.achievementId);
    // One second later it is Monday in Zurich (still Sunday in UTC): the missed week closed and resets the habit.
    ctx.clock.set('2026-11-01T23:00:00Z');
    const closed = await sync(goal.userId, goal.achievementId);

    expect(open?.view.quests[0]?.evaluation).toMatchObject({
      state: 'available',
      currentPeriod: { start: '2026-10-26', end: '2026-11-01' },
    });
    expect(closed?.view.quests[0]?.evaluation.state).toBe('needs_restart');
  });
});
