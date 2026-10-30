import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { settleAsLost } from '../../src/domain/gamble.ts';
import { rankBonus } from '../../src/domain/rank.ts';
import { levelForXp } from '../../src/domain/xp.ts';
import { checkInsRepository } from '../../src/modules/check-ins/repository.ts';
import { withGoals, type GoalDependencies } from '../../src/modules/goals/engine.ts';
import { createDatabaseClient, type DatabaseClient } from '../../src/platform/db/client.ts';
import { createDatabase } from '../../src/platform/db/database.ts';
import { startAccountsApp, type AccountsApp } from '../helpers/accounts-app.ts';
import { contractInject } from '../helpers/contract.ts';
import { bearer, createAchievement, goalUser, loggedInAgain, type GoalUser } from '../helpers/goals.ts';

const START = '2026-10-29T12:00:00Z';
const TODAY = '2026-10-29'; // in Europe/Zurich, a Thursday
const DAY_MS = 86_400_000;

interface Quest {
  readonly id: string;
  readonly version: number;
  readonly [field: string]: unknown;
}

interface Effects {
  readonly quest: Quest | null;
  readonly achievement: Record<string, unknown>;
  readonly [field: string]: unknown;
}

const FIXED_WHILE_RUNNING = 'cannot change while the habit runs or after it completed, only before or at a restart';
const daily = (periodCount: number, extra: Record<string, unknown> = {}) => ({
  type: 'habit',
  habit: { period: 'day', times_per_period: 1, period_count: periodCount, ...extra },
});

/** Editing and deleting quests (contract tag `quests`): rules, concurrency and their effects through the engine. */
describe('quest edits and deletions [R-QST-07, R-QST-08, Q-12, Q-37, Q-38, Q-41, A-37, A-39, A-41]', () => {
  let ctx: AccountsApp;
  let client: DatabaseClient;
  let deps: GoalDependencies;

  const achievementOf = async (user: GoalUser, body: Record<string, unknown> = { title: 'Goal' }) =>
    (await createAchievement(ctx, user.token, body)).json<{ id: string }>().id;
  const createQuest = async (user: GoalUser, achievementId: string, body: Record<string, unknown>) => {
    const response = await ctx.post(
      `/v1/achievements/${achievementId}/quests`,
      { title: 'Quest', type: 'one_time', size: 'M', ...body },
      { ...bearer(user.token), 'idempotency-key': randomUUID() },
    );
    if (response.statusCode !== 201) throw new Error(`quest not created: ${String(response.statusCode)}`);
    return response.json<Quest>();
  };
  /** Moves the clock on; the access token has expired by then, so the user logs in again. */
  const afterDays = (user: GoalUser, days: number) => {
    ctx.clock.advance({ days });
    return loggedInAgain(ctx, user);
  };
  const tag = (version: number) => `"${String(version)}"`;
  const patchQuest = (user: GoalUser, questId: string, body: unknown, ifMatch?: string) =>
    contractInject(ctx.app, {
      method: 'PATCH',
      url: `/v1/quests/${questId}`,
      headers: {
        ...bearer(user.token),
        'content-type': 'application/json',
        ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }),
      },
      payload: JSON.stringify(body),
    });
  const deleteQuest = (user: GoalUser, questId: string, ifMatch?: string) =>
    contractInject(ctx.app, {
      method: 'DELETE',
      url: `/v1/quests/${questId}`,
      headers: { ...bearer(user.token), ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }) },
    });
  const getQuest = async (user: GoalUser, questId: string) =>
    (
      await contractInject(ctx.app, { method: 'GET', url: `/v1/quests/${questId}`, headers: bearer(user.token) })
    ).json<Quest>();
  const getAchievement = (user: GoalUser, achievementId: string) =>
    contractInject(ctx.app, { method: 'GET', url: `/v1/achievements/${achievementId}`, headers: bearer(user.token) });
  /** A counting check-in today, as `createCheckIn` will store it (m3-check-ins). */
  const checkIn = (user: GoalUser, questId: string, value: string | null = null) =>
    withGoals(deps, user.userId, (scope) =>
      checkInsRepository(scope.tx, user.userId, scope.dataKey).insert(
        { questId, localDate: scope.today, attempt: 1, countsForProgress: true, value, note: null },
        scope.now,
      ),
    );
  const questRow = async (questId: string) =>
    (
      await ctx.admin.sql<Record<string, unknown>[]>`
        select prerequisite_quest_id, needs_restart, reset_count, habit_start_date::text as start_date,
               habit_week_start as week_start, unit_enc, version
        from quests where id = ${questId}`
    )[0];
  const ledger = async (userId: string) =>
    (
      await ctx.admin.sql<{ kind: string; amount: number; quest_id: string | null }[]>`
        select kind, amount::int as amount, quest_id from xp_events where user_id = ${userId}
        order by created_at, xmin::text::bigint, kind, amount`
    ).map((event) => ({ ...event }));

  beforeAll(async () => {
    ctx = await startAccountsApp();
    client = createDatabaseClient({ url: ctx.database.urls.app, applicationName: 'questline-test' });
    deps = { db: createDatabase(client), dataKeys: ctx.dataKeys, clock: ctx.clock };
  });

  afterAll(async () => {
    await client.close();
    await ctx.close();
  });

  beforeEach(() => {
    ctx.clock.set(START);
  });

  it('edits title, notes, size, required flag and position, with the new version and the effects [R-QST-07]', async () => {
    const user = await goalUser(ctx);
    const achievementId = await achievementOf(user);
    const quest = await createQuest(user, achievementId, { title: 'Draft', notes: 'old', size: 'S' });

    const response = await patchQuest(
      user,
      quest.id,
      { title: 'Final', notes: 'new notes', size: 'L', is_required: false, position: 3 },
      tag(1),
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe('"2"');
    const effects = response.json<Effects>();
    expect(effects.quest).toEqual({
      ...quest,
      title: 'Final',
      notes: 'new notes',
      size: 'L',
      xp: 50,
      is_required: false,
      position: 3,
      version: 2,
    });
    expect(effects).toMatchObject({
      achievement: { id: achievementId, progress: 0, xp_required_total: 0, xp_earned: 0 },
      xp_delta: 0,
      xp_total: 0,
      level: 1,
      achievement_unlocked: false,
      achievement_relocked: false,
      rank: null,
      execution_score: null,
      gamble: null,
    });
    const [row] = await ctx.admin.sql<{ title_enc: Buffer; notes_enc: Buffer }[]>`
      select title_enc, notes_enc from quests where id = ${quest.id}`;
    expect(await ctx.decrypt(user.userId, quest.id, 'title_enc', row?.title_enc ?? Buffer.alloc(0))).toBe('Final');
    expect(await ctx.decrypt(user.userId, quest.id, 'notes_enc', row?.notes_enc ?? Buffer.alloc(0))).toBe('new notes');
    const cleared = await patchQuest(user, quest.id, { notes: null }, tag(2));
    expect(cleared.json<Effects>().quest).toMatchObject({ notes: null, version: 3 });
  });

  it('moves a completed quest’s XP with its size [R-XP-01, R-XP-02]', async () => {
    const user = await goalUser(ctx);
    const achievementId = await achievementOf(user);
    const done = await createQuest(user, achievementId, { size: 'S' });
    await createQuest(user, achievementId, { title: 'Still open' });
    await checkIn(user, done.id);
    expect((await getQuest(user, done.id)).version).toBe(2);

    const response = await patchQuest(user, done.id, { size: 'L' }, tag(2));

    expect(response.json()).toMatchObject({
      quest: { state: 'completed', xp: 50 },
      achievement: { xp_earned: 50 },
      xp_delta: 40,
      xp_total: 50,
    });
    expect(await ledger(user.userId)).toEqual([
      { kind: 'quest_completed', amount: 10, quest_id: done.id },
      { kind: 'quest_completed', amount: 40, quest_id: done.id },
    ]);
  });

  it('unlocks the achievement when its last open required quest becomes a bonus: rank, score and bonus [R-ACH-04]', async () => {
    let user = await goalUser(ctx);
    const achievementId = await achievementOf(user);
    const done = await createQuest(user, achievementId, { title: 'Done' });
    const open = await createQuest(user, achievementId, { title: 'Open' });
    user = await afterDays(user, 8);
    await checkIn(user, done.id);
    await getAchievement(user, achievementId);

    const response = await patchQuest(user, open.id, { is_required: false }, tag(1));

    // A bonus quest left open rules out Champion (R-RANK-02).
    const bonus = rankBonus(25, 'diamond', 8 * DAY_MS);
    expect(bonus).toBeGreaterThan(0);
    expect(response.json()).toMatchObject({
      quest: { is_required: false, state: 'available' },
      achievement: { status: 'completed', rank: 'diamond', execution_score: 100, xp_earned: 25 + bonus },
      xp_delta: bonus,
      xp_total: 25 + bonus,
      level: levelForXp(25 + bonus),
      achievement_unlocked: true,
      achievement_relocked: false,
      rank: 'diamond',
      execution_score: 100,
      gamble: null,
    });
  });

  it('needs If-Match: 428 without, 400 for anything but one version, 409 with the current version when stale [ADR-0008]', async () => {
    const user = await goalUser(ctx);
    const quest = await createQuest(user, await achievementOf(user), { title: 'Versioned' });

    for (const request of [() => patchQuest(user, quest.id, { title: 'x' }), () => deleteQuest(user, quest.id)]) {
      const missing = await request();
      expect(missing.statusCode).toBe(428);
      expect(missing.json()).toMatchObject({ type: 'urn:questline:problem:precondition-required' });
    }
    for (const ifMatch of ['W/"1"', '"1", "2"', '*', '1']) {
      expect((await patchQuest(user, quest.id, { title: 'x' }, ifMatch)).statusCode).toBe(400);
      expect((await deleteQuest(user, quest.id, ifMatch)).statusCode).toBe(400);
    }
    expect((await patchQuest(user, quest.id, { title: 'First' }, tag(1))).statusCode).toBe(200);
    for (const stale of [
      await patchQuest(user, quest.id, { title: 'Second' }, tag(1)),
      await deleteQuest(user, quest.id, tag(1)),
    ]) {
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ type: 'urn:questline:problem:version-conflict', current_version: 2 });
    }
    expect(await getQuest(user, quest.id)).toMatchObject({ title: 'First', version: 2 });
  });

  it('answers 404 for another user’s, an unknown or a malformed quest ID [R-AUTHZ-02]', async () => {
    const owner = await goalUser(ctx);
    const intruder = await goalUser(ctx);
    const quest = await createQuest(owner, await achievementOf(owner), { title: 'Mine' });

    for (const [user, id] of [
      [intruder, quest.id],
      [owner, randomUUID()],
      [owner, 'not-a-uuid'],
    ] as const) {
      expect((await patchQuest(user, id, { title: 'Stolen' }, tag(1))).statusCode).toBe(404);
      expect((await deleteQuest(user, id, tag(1))).statusCode).toBe(404);
    }
    expect(await getQuest(owner, quest.id)).toMatchObject({ title: 'Mine', version: 1 });
  });

  it('refuses edits and deletions in a completed achievement with 409, whatever the version [R-QST-07, R-ACH-07]', async () => {
    const user = await goalUser(ctx);
    const achievementId = await achievementOf(user);
    const quest = await createQuest(user, achievementId, { title: 'Only one' });
    await checkIn(user, quest.id);
    await getAchievement(user, achievementId);

    for (const refused of [
      await patchQuest(user, quest.id, { title: 'Rewritten' }, tag(1)),
      await patchQuest(user, quest.id, { title: 'Rewritten' }, tag(2)),
      await deleteQuest(user, quest.id, tag(2)),
    ]) {
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ type: 'urn:questline:problem:achievement-completed' });
    }
    expect(await getQuest(user, quest.id)).toMatchObject({ title: 'Only one', state: 'completed' });
  });

  it.each([
    ['an empty body', {}],
    ['the type', { type: 'habit' }],
    ['XP', { xp: 500 }],
    ['a state', { state: 'completed' }],
    ['target values without the target value', { target: { start_value: '1' } }],
    ['an unknown habit setting', { habit: { period: 'day', times_per_period: 1, period_count: 3, reset_count: 0 } }],
    ['a malformed prerequisite', { prerequisite_quest_id: 'not-a-uuid' }],
  ])('refuses an edit with %s with 400 [R-IN-01, R-AUTHZ-04]', async (_case, body) => {
    const user = await goalUser(ctx);
    const quest = await createQuest(user, await achievementOf(user), {});

    const response = await patchQuest(user, quest.id, body, tag(1));

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ type: 'urn:questline:problem:validation' });
  });

  it.each<[string, keyof Ids, (ids: Ids) => unknown, string, string]>([
    [
      'habit settings on a one-time quest',
      'once',
      () => ({ habit: { period: 'day', times_per_period: 1, period_count: 3 } }),
      '/habit',
      'is only for habit quests',
    ],
    [
      'target values on a habit quest',
      'habit',
      () => ({ target: { start_value: '1', target_value: '2' } }),
      '/target',
      'is only for target quests',
    ],
    [
      'equal values',
      'target',
      () => ({ target: { start_value: '5', target_value: '5.0' } }),
      '/target/target_value',
      'must differ from start_value',
    ],
    [
      'a value beyond 10^9',
      'target',
      () => ({ target: { start_value: '-1000000000.001', target_value: '1' } }),
      '/target/start_value',
      'must lie within ±1000000000',
    ],
    [
      'a start date in the past',
      'habit',
      () => ({ habit: { period: 'day', times_per_period: 1, period_count: 3, start_date: '2026-10-28' } }),
      '/habit/start_date',
      'must be today or later: back-dated check-ins never count',
    ],
    [
      'an unknown prerequisite',
      'once',
      () => ({ prerequisite_quest_id: randomUUID() }),
      '/prerequisite_quest_id',
      'is not a quest of this achievement',
    ],
    [
      'itself as prerequisite',
      'once',
      (ids) => ({ prerequisite_quest_id: ids.once }),
      '/prerequisite_quest_id',
      'would make a cycle',
    ],
    [
      'a cycle',
      'once',
      (ids) => ({ prerequisite_quest_id: ids.target }),
      '/prerequisite_quest_id',
      'would make a cycle',
    ],
  ])(
    'refuses %s with 422 and changes nothing [A-05, A-16, A-28, R-QST-02…05]',
    async (_case, name, body, pointer, message) => {
      const user = await goalUser(ctx);
      const achievementId = await achievementOf(user);
      const once = await createQuest(user, achievementId, { title: 'Once' });
      const ids: Ids = {
        once: once.id,
        // Not begun yet, so its settings may change (Q-37).
        habit: (await createQuest(user, achievementId, daily(3, { start_date: '2026-11-02' }))).id,
        target: (
          await createQuest(user, achievementId, {
            type: 'target',
            target: { start_value: '0', target_value: '10' },
            prerequisite_quest_id: once.id,
          })
        ).id,
      };

      const response = await patchQuest(user, ids[name], body(ids), tag(1));

      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        type: 'urn:questline:problem:unprocessable',
        errors: [{ pointer, message }],
      });
      expect(await questRow(ids[name])).toMatchObject({ version: 1 });
    },
  );

  it('fixes a running habit’s settings and prerequisite, keeps the rest editable, and keeps an omitted start date [Q-37, Q-38, Q-41]', async () => {
    const user = await goalUser(ctx);
    const achievementId = await achievementOf(user);
    const other = await createQuest(user, achievementId, { title: 'Other' });
    const habit = await createQuest(user, achievementId, daily(5));

    for (const [body, pointer] of [
      [{ habit: { period: 'day', times_per_period: 2, period_count: 5 } }, '/habit'],
      [{ habit: { period: 'week', times_per_period: 1, period_count: 5 } }, '/habit'],
      [{ habit: { period: 'day', times_per_period: 1, period_count: 5, start_date: '2026-10-30' } }, '/habit'],
      [{ prerequisite_quest_id: other.id }, '/prerequisite_quest_id'],
    ] as const) {
      const refused = await patchQuest(user, habit.id, body, tag(1));
      expect(refused.statusCode).toBe(422);
      expect(refused.json()).toMatchObject({ errors: [{ pointer, message: FIXED_WHILE_RUNNING }] });
    }
    const renamed = await patchQuest(
      user,
      habit.id,
      { title: 'Renamed', size: 'L', habit: { period: 'day', times_per_period: 1, period_count: 5 } },
      tag(1),
    );

    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<Effects>().quest).toMatchObject({
      title: 'Renamed',
      xp: 50,
      habit: { period: 'day', times_per_period: 1, period_count: 5, start_date: TODAY },
      version: 2,
    });
  });

  it('changes a habit before its run begins, which then takes the account’s current week start [Q-37, A-41, Q-33]', async () => {
    const user = await goalUser(ctx);
    const achievementId = await achievementOf(user);
    const habit = await createQuest(user, achievementId, {
      type: 'habit',
      habit: { period: 'week', times_per_period: 3, period_count: 8, start_date: '2026-11-02' },
    });
    expect(await questRow(habit.id)).toMatchObject({ week_start: 'monday' });
    await ctx.admin.sql`update users set week_start = 'sunday' where id = ${user.userId}`;

    const response = await patchQuest(
      user,
      habit.id,
      { habit: { period: 'week', times_per_period: 2, period_count: 4, start_date: '2026-11-03' } },
      tag(1),
    );

    expect(response.statusCode).toBe(200);
    expect(response.json<Effects>().quest).toMatchObject({
      xp: 25,
      duration_factor: 1,
      habit: { period: 'week', times_per_period: 2, period_count: 4, start_date: '2026-11-03' },
      // Tuesday to the end of the first full Sunday-to-Saturday week (Q-33).
      current_period: { start: '2026-11-03', end: '2026-11-14', check_ins: 0, required_check_ins: 2 },
    });
    expect(await questRow(habit.id)).toMatchObject({ week_start: 'sunday', start_date: '2026-11-03' });
  });

  it('lets a locked habit lose its prerequisite; its run then starts today instead of resetting [Q-38]', async () => {
    let user = await goalUser(ctx);
    const achievementId = await achievementOf(user);
    const first = await createQuest(user, achievementId, { title: 'First' });
    const habit = await createQuest(user, achievementId, { ...daily(3), prerequisite_quest_id: first.id });
    user = await afterDays(user, 2);
    expect(await getQuest(user, habit.id)).toMatchObject({ state: 'locked', version: 1 });

    const response = await patchQuest(user, habit.id, { prerequisite_quest_id: null }, tag(1));

    expect(response.json<Effects>().quest).toMatchObject({
      state: 'available',
      prerequisite_quest_id: null,
      reset_count: 0,
      habit: { start_date: '2026-10-31' },
      current_period: { start: '2026-10-31', end: '2026-10-31', check_ins: 0, required_check_ins: 1 },
    });
    expect(await questRow(habit.id)).toMatchObject({ needs_restart: false, start_date: '2026-10-31' });
  });

  it('restarts a habit that needs it: today or later, with new settings, the earlier check-ins as history [R-QST-04, Q-41]', async () => {
    let user = await goalUser(ctx);
    const achievementId = await achievementOf(user);
    const habit = await createQuest(user, achievementId, daily(3));
    await checkIn(user, habit.id);
    user = await afterDays(user, 2);
    expect(await getQuest(user, habit.id)).toMatchObject({ state: 'needs_restart', reset_count: 1, version: 2 });

    for (const startDate of [TODAY, '2026-10-30']) {
      const refused = await patchQuest(
        user,
        habit.id,
        { habit: { period: 'day', times_per_period: 1, period_count: 3, start_date: startDate } },
        tag(2),
      );
      expect(refused.json()).toMatchObject({ errors: [{ pointer: '/habit/start_date' }] });
    }
    const restarted = await patchQuest(
      user,
      habit.id,
      { habit: { period: 'day', times_per_period: 2, period_count: 2 } },
      tag(2),
    );

    expect(restarted.statusCode).toBe(200);
    expect(restarted.json<Effects>().quest).toMatchObject({
      state: 'available',
      progress: 0,
      reset_count: 1,
      habit: { period: 'day', times_per_period: 2, period_count: 2, start_date: '2026-10-31' },
      streak: { current: 0, best: 1, period: 'day' },
      current_period: { start: '2026-10-31', end: '2026-10-31', check_ins: 0, required_check_ins: 2 },
      version: 3,
    });
    expect(await questRow(habit.id)).toMatchObject({ needs_restart: false, start_date: '2026-10-31' });
  });

  it('lets a paused achievement’s habit change, as no run is going while paused [A-39]', async () => {
    let user = await goalUser(ctx);
    const achievementId = await achievementOf(user);
    const habit = await createQuest(user, achievementId, daily(5));
    user = await afterDays(user, 1);
    await ctx.admin.sql`update achievements set status = 'paused' where id = ${achievementId}`;

    const response = await patchQuest(
      user,
      habit.id,
      { habit: { period: 'day', times_per_period: 2, period_count: 5 } },
      tag(1),
    );

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      quest: { habit: { times_per_period: 2, start_date: TODAY } },
      achievement: { status: 'paused' },
      xp_delta: 0,
      achievement_unlocked: false,
      gamble: null,
    });
  });

  it('keeps a completed quest’s target values, while its unit may change or go [A-37, Q-41]', async () => {
    const user = await goalUser(ctx);
    const achievementId = await achievementOf(user);
    const target = await createQuest(user, achievementId, {
      type: 'target',
      target: { start_value: '0', target_value: '10', unit: 'km' },
    });
    await createQuest(user, achievementId, { title: 'Keeps the achievement open' });
    await checkIn(user, target.id, '10');
    expect(await getQuest(user, target.id)).toMatchObject({ state: 'completed', version: 2 });

    for (const [values, pointer] of [
      [{ start_value: '0', target_value: '12' }, '/target/target_value'],
      [{ start_value: '1', target_value: '10' }, '/target/start_value'],
    ] as const) {
      const refused = await patchQuest(user, target.id, { target: values }, tag(2));
      expect(refused.json()).toMatchObject({
        errors: [{ pointer, message: 'cannot change once the quest is completed' }],
      });
    }
    const renamed = await patchQuest(
      user,
      target.id,
      { target: { start_value: '0.000', target_value: '10.0', unit: 'miles' } },
      tag(2),
    );
    const kept = await patchQuest(user, target.id, { target: { start_value: '0', target_value: '10' } }, tag(3));
    const removed = await patchQuest(
      user,
      target.id,
      { target: { start_value: '0', target_value: '10', unit: null } },
      tag(4),
    );

    expect(renamed.json<Effects>().quest).toMatchObject({
      target: { start_value: '0', target_value: '10', unit: 'miles' },
    });
    expect(kept.json<Effects>().quest).toMatchObject({ target: { unit: 'miles' }, state: 'completed' });
    expect(removed.json<Effects>().quest?.['target']).toEqual({ start_value: '0', target_value: '10' });
    expect(await questRow(target.id)).toMatchObject({ unit_enc: null, version: 5 });
  });

  it('completes an open target quest whose new target its value already reaches [R-QST-05, R-QST-07]', async () => {
    const user = await goalUser(ctx);
    const achievementId = await achievementOf(user);
    const target = await createQuest(user, achievementId, {
      type: 'target',
      target: { start_value: '0', target_value: '10' },
    });
    await createQuest(user, achievementId, { title: 'Keeps the achievement open' });
    await checkIn(user, target.id, '5');

    const response = await patchQuest(user, target.id, { target: { start_value: '0', target_value: '5' } }, tag(1));

    expect(response.json()).toMatchObject({
      quest: { state: 'completed', progress: 1, current_value: '5' },
      achievement: { status: 'active', xp_earned: 25 },
      xp_delta: 25,
      xp_total: 25,
      achievement_unlocked: false,
    });
  });

  it('reports a gamble lost since the last request among the effects of an edit [A-21, R-GMB-03]', async () => {
    let user = await goalUser(ctx);
    const achievementId = await achievementOf(user, { title: 'Goal', target_date: '2026-11-05' });
    const quest = await createQuest(user, achievementId, { title: 'Slow' });
    await ctx.admin.sql`
      insert into xp_events (id, user_id, kind, amount, local_date, created_at)
      values (${randomUUID()}, ${user.userId}, 'quest_completed', 1000, ${TODAY}, ${ctx.clock.now()})`;
    const gambleId = randomUUID();
    await ctx.admin.sql`
      insert into gambles (id, user_id, achievement_id, attempt, stake, status, placed_at)
      values (${gambleId}, ${user.userId}, ${achievementId}, 1, 150, 'pending', ${ctx.clock.now()})`;
    user = await afterDays(user, 8);

    const response = await patchQuest(user, quest.id, { title: 'Renamed' }, tag(1));

    const lost = settleAsLost(150, 1000, 'target_date_passed').xpDelta;
    expect(lost).toBeLessThan(0);
    expect(response.json()).toMatchObject({
      quest: { title: 'Renamed' },
      xp_delta: lost,
      xp_total: 1000 + lost,
      level: levelForXp(1000 + lost),
      gamble: { gamble_id: gambleId, outcome: 'lost', xp_delta: lost, loss_reason: 'target_date_passed' },
    });
  });

  it('deletes a quest with its check-ins, revokes its XP and detaches the quests that required it [R-QST-08, Q-12]', async () => {
    const user = await goalUser(ctx);
    const achievementId = await achievementOf(user);
    const first = await createQuest(user, achievementId, { title: 'First' });
    const next = await createQuest(user, achievementId, { title: 'Next', size: 'S', prerequisite_quest_id: first.id });
    await createQuest(user, achievementId, { title: 'Keeps the achievement open' });
    await checkIn(user, first.id);
    expect(await getQuest(user, first.id)).toMatchObject({ state: 'completed', version: 2 });

    const response = await deleteQuest(user, first.id, tag(2));

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBeUndefined();
    expect(response.json()).toMatchObject({
      quest: null,
      achievement: { id: achievementId, status: 'active', xp_earned: 0, xp_required_total: 35 },
      xp_delta: -25,
      xp_total: 0,
      achievement_unlocked: false,
      gamble: null,
    });
    expect(
      (await contractInject(ctx.app, { method: 'GET', url: `/v1/quests/${first.id}`, headers: bearer(user.token) }))
        .statusCode,
    ).toBe(404);
    expect(await ctx.admin.sql`select id from check_ins where quest_id = ${first.id}`).toHaveLength(0);
    expect(await questRow(next.id)).toMatchObject({ prerequisite_quest_id: null, version: 2 });
    expect(await getQuest(user, next.id)).toMatchObject({ state: 'available', prerequisite_quest_id: null });
    expect(await ledger(user.userId)).toEqual([
      { kind: 'quest_completed', amount: 25, quest_id: null },
      { kind: 'quest_deleted', amount: -25, quest_id: null },
    ]);
  });

  it('unlocks the achievement when its last open required quest is deleted [R-ACH-04, R-QST-08]', async () => {
    const user = await goalUser(ctx);
    const achievementId = await achievementOf(user);
    const done = await createQuest(user, achievementId, { title: 'Done' });
    const open = await createQuest(user, achievementId, { title: 'Open' });
    await checkIn(user, done.id);
    await getAchievement(user, achievementId);

    const response = await deleteQuest(user, open.id, tag(1));

    expect(response.json()).toMatchObject({
      quest: null,
      achievement: { status: 'completed', rank: 'champion', execution_score: 100, xp_earned: 25 },
      xp_delta: 0,
      xp_total: 25,
      achievement_unlocked: true,
      rank: 'champion',
      execution_score: 100,
    });
  });

  it('starts a locked habit’s run today when its open prerequisite is deleted [Q-38, R-QST-08]', async () => {
    let user = await goalUser(ctx);
    const achievementId = await achievementOf(user);
    const first = await createQuest(user, achievementId, { title: 'First' });
    const habit = await createQuest(user, achievementId, { ...daily(3), prerequisite_quest_id: first.id });
    user = await afterDays(user, 2);

    expect((await deleteQuest(user, first.id, tag(1))).statusCode).toBe(200);

    expect(await getQuest(user, habit.id)).toMatchObject({
      state: 'available',
      prerequisite_quest_id: null,
      reset_count: 0,
      habit: { start_date: '2026-10-31' },
    });
  });
});

interface Ids {
  readonly once: string;
  readonly habit: string;
  readonly target: string;
}
