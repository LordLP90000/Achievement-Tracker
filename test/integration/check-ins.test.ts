import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { addDays } from '../../src/domain/dates.ts';
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

interface Resource {
  readonly id: string;
  readonly [field: string]: unknown;
}

interface CheckInResult {
  readonly check_in: Resource;
  readonly quest: Resource;
  readonly achievement: Resource;
  readonly [field: string]: unknown;
}

/** Check-ins (contract tag `check-ins`): record, list and undo, with their effects through the goal engine. */
describe('check-ins [R-CHK-01…06, R-ACH-05, R-IN-01, Q-36, Q-42, Q-43, A-36, A-42]', () => {
  let ctx: AccountsApp;
  let client: DatabaseClient;
  let deps: GoalDependencies;

  const achievementOf = async (user: GoalUser, body: Record<string, unknown> = { title: 'Goal' }) =>
    (await createAchievement(ctx, user.token, body)).json<{ id: string }>().id;
  const createQuest = async (user: GoalUser, achievementId: string, body: Record<string, unknown> = {}) => {
    const response = await ctx.post(
      `/v1/achievements/${achievementId}/quests`,
      { title: 'Quest', type: 'one_time', size: 'M', ...body },
      { ...bearer(user.token), 'idempotency-key': randomUUID() },
    );
    if (response.statusCode !== 201) throw new Error(`quest not created: ${String(response.statusCode)}`);
    return response.json<Resource>();
  };
  const checkIn = (user: GoalUser, questId: string, body: unknown = { local_date: TODAY }, key = randomUUID()) =>
    ctx.post(`/v1/quests/${questId}/check-ins`, body, { ...bearer(user.token), 'idempotency-key': key });
  const listCheckIns = (user: GoalUser, questId: string, query = '') =>
    contractInject(ctx.app, {
      method: 'GET',
      url: `/v1/quests/${questId}/check-ins${query}`,
      headers: bearer(user.token),
    });
  const undo = (user: GoalUser, checkInId: string) =>
    contractInject(ctx.app, { method: 'DELETE', url: `/v1/check-ins/${checkInId}`, headers: bearer(user.token) });
  const get = async (user: GoalUser, url: string) =>
    (await contractInject(ctx.app, { method: 'GET', url, headers: bearer(user.token) })).json<Resource>();
  /** Moves the clock on; the access token has expired by then, so the user logs in again. */
  const afterDays = (user: GoalUser, days: number) => {
    ctx.clock.advance({ days });
    return loggedInAgain(ctx, user);
  };
  const ledger = async (userId: string) =>
    (
      await ctx.admin.sql<{ kind: string; amount: number }[]>`
        select kind, amount::int as amount from xp_events where user_id = ${userId}
        order by created_at, xmin::text::bigint, kind, amount`
    ).map((event) => ({ ...event }));
  const storedCheckIns = (questId: string) =>
    ctx.admin.sql<Record<string, unknown>[]>`select * from check_ins where quest_id = ${questId}`;
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
  const gambleStatus = async (gambleId: string) =>
    (await ctx.admin.sql<{ status: string }[]>`select status from gambles where id = ${gambleId}`)[0]?.status;

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

  it('records a check-in dated today that counts, with what it did, and the account’s XP follows [R-CHK-01, R-CHK-06, R-XP-04]', async () => {
    const user = await goalUser(ctx);
    const achievementId = await achievementOf(user);
    const quest = await createQuest(user, achievementId);
    await createQuest(user, achievementId, { title: 'Keeps the achievement open' });

    const response = await checkIn(user, quest.id, { local_date: TODAY, note: 'Done!' });

    expect(response.statusCode).toBe(201);
    const result = response.json<CheckInResult>();
    expect(response.headers.location).toBe(`/v1/check-ins/${result.check_in.id}`);
    expect(result).toMatchObject({
      check_in: {
        quest_id: quest.id,
        local_date: TODAY,
        attempt: 1,
        counts_for_progress: true,
        value: null,
        note: 'Done!',
        created_at: ctx.clock.now().toISOString(),
      },
      quest: { id: quest.id, state: 'completed', progress: 1, version: 2 },
      achievement: { id: achievementId, status: 'active', progress: 0.5, xp_earned: 25 },
      xp_delta: 25,
      xp_total: 25,
      level: 1,
      achievement_unlocked: false,
      achievement_relocked: false,
      rank: null,
      execution_score: null,
      gamble: null,
    });
    expect(await get(user, '/v1/me')).toMatchObject({ xp_total: 25, level: 1 });
    await giveXp(user.userId, 975);
    expect(levelForXp(1000)).toBeGreaterThan(1);
    expect(await get(user, '/v1/me')).toMatchObject({ xp_total: 1000, level: levelForXp(1000) });
  });

  it('unlocks the achievement with its last open required quest: Champion, score 100 [R-ACH-04, R-RANK-02]', async () => {
    const user = await goalUser(ctx);
    const achievementId = await achievementOf(user);
    const quest = await createQuest(user, achievementId);

    const result = (await checkIn(user, quest.id)).json<CheckInResult>();

    expect(result).toMatchObject({
      achievement: { status: 'completed', rank: 'champion', execution_score: 100, xp_earned: 25 },
      xp_delta: 25,
      achievement_unlocked: true,
      rank: 'champion',
      execution_score: 100,
    });
  });

  it('keeps a back-dated check-in as history that never counts [R-CHK-04, Q-08]', async () => {
    const user = await goalUser(ctx);
    const quest = await createQuest(user, await achievementOf(user));

    const result = (await checkIn(user, quest.id, { local_date: '2026-10-22' })).json<CheckInResult>();

    expect(result).toMatchObject({
      check_in: { local_date: '2026-10-22', counts_for_progress: false },
      quest: { state: 'available', progress: 0 },
      xp_delta: 0,
    });
  });

  it('dates check-ins by the account’s day, at local midnight and on both Zurich DST dates [R-CHK-04, ADR-0011]', async () => {
    ctx.clock.set('2026-10-24T21:59:59Z');
    let user = await goalUser(ctx);
    const quest = await createQuest(user, await achievementOf(user), {
      type: 'target',
      target: { start_value: '0', target_value: '100' },
    });
    const instants = [
      ['2026-10-24T21:59:59Z', '2026-10-24'], // 23:59:59 summer time
      ['2026-10-24T22:00:00Z', '2026-10-25'], // midnight: the 25-hour day begins
      ['2026-10-25T22:59:59Z', '2026-10-25'], // 23:59:59 winter time
      ['2026-10-25T23:00:00Z', '2026-10-26'],
      ['2027-03-27T22:59:59Z', '2027-03-27'],
      ['2027-03-27T23:00:00Z', '2027-03-28'], // midnight: the 23-hour day begins
      ['2027-03-28T21:59:59Z', '2027-03-28'], // 23:59:59 summer time
      ['2027-03-28T22:00:00Z', '2027-03-29'],
    ] as const;

    for (const [index, [instant, day]] of instants.entries()) {
      ctx.clock.set(instant);
      user = await loggedInAgain(ctx, user);
      const counted = await checkIn(user, quest.id, { local_date: day, value: String(index + 1) });
      const early = await checkIn(user, quest.id, { local_date: addDays(day, 1), value: '1' });

      expect(counted.json()).toMatchObject({ check_in: { local_date: day, counts_for_progress: true } });
      expect(early.json()).toMatchObject({
        errors: [{ pointer: '/local_date', message: 'must not be in the future' }],
      });
    }
  });

  it('measures a target quest by its latest value, stored canonical and encrypted with the note [R-QST-05, R-CHK-02]', async () => {
    const user = await goalUser(ctx);
    const achievementId = await achievementOf(user);
    const target = await createQuest(user, achievementId, {
      type: 'target',
      target: { start_value: '80', target_value: '70', unit: 'kg' },
    });
    await createQuest(user, achievementId, { title: 'Keeps the achievement open' });

    const halfway = (
      await checkIn(user, target.id, { local_date: TODAY, value: '75.50', note: 'Morning' })
    ).json<CheckInResult>();
    ctx.clock.advance({ minutes: 1 });
    const reached = (await checkIn(user, target.id, { local_date: TODAY, value: '70.000' })).json<CheckInResult>();

    expect(halfway).toMatchObject({
      check_in: { value: '75.5', note: 'Morning' },
      quest: { current_value: '75.5', progress: 0.45, state: 'available' },
    });
    expect(reached).toMatchObject({ quest: { current_value: '70', progress: 1, state: 'completed' }, xp_delta: 25 });
    const row = (await storedCheckIns(target.id)).find((stored) => stored['id'] === halfway.check_in.id) ?? {};
    for (const [field, plaintext] of [
      ['value_enc', '75.5'],
      ['note_enc', 'Morning'],
    ] as const) {
      const blob = row[field] as Buffer;
      expect(blob.toString('latin1')).not.toContain(plaintext);
      expect(await ctx.decrypt(user.userId, halfway.check_in.id, field, blob)).toBe(plaintext);
    }
  });

  it('starts a locked habit’s run on the day its prerequisite completes, instead of resetting it [Q-38]', async () => {
    let user = await goalUser(ctx);
    const achievementId = await achievementOf(user);
    const first = await createQuest(user, achievementId, { title: 'First' });
    const habit = await createQuest(user, achievementId, {
      type: 'habit',
      habit: { period: 'day', times_per_period: 1, period_count: 3 },
      prerequisite_quest_id: first.id,
    });
    user = await afterDays(user, 2);

    await checkIn(user, first.id, { local_date: '2026-10-31' });

    expect(await get(user, `/v1/quests/${habit.id}`)).toMatchObject({
      state: 'available',
      reset_count: 0,
      habit: { start_date: '2026-10-31' },
      current_period: { start: '2026-10-31', end: '2026-10-31' },
    });
  });

  it('refuses a check-in on a locked, completed or reset quest, or in an achievement that is not active, with 409 [R-CHK-05, Q-42]', async () => {
    let user = await goalUser(ctx);
    const active = await achievementOf(user);
    const done = await createQuest(user, active, { title: 'Done' });
    const locked = await createQuest(user, active, {
      title: 'Locked',
      prerequisite_quest_id: (await createQuest(user, active, { title: 'Open' })).id,
    });
    const habit = await createQuest(user, active, {
      type: 'habit',
      habit: { period: 'day', times_per_period: 1, period_count: 3 },
    });
    await checkIn(user, done.id);
    const paused = await achievementOf(user);
    const inPause = await createQuest(user, paused);
    await ctx.admin.sql`update achievements set status = 'paused' where id = ${paused}`;
    const completed = await achievementOf(user);
    const only = await createQuest(user, completed);
    await checkIn(user, only.id);

    const refusals = [
      [done.id, 'quest-completed'],
      [locked.id, 'quest-locked'],
      [inPause.id, 'achievement-not-active'],
      [only.id, 'achievement-not-active'],
    ] as const;
    for (const [questId, slug] of refusals) {
      const refused = await checkIn(user, questId, { local_date: '2026-10-28' });
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ type: `urn:questline:problem:${slug}` });
    }
    user = await afterDays(user, 2);
    const reset = await checkIn(user, habit.id, { local_date: '2026-10-31' });
    expect(reset.statusCode).toBe(409);
    expect(reset.json()).toMatchObject({ type: 'urn:questline:problem:quest-needs-restart' });
    expect(await storedCheckIns(locked.id)).toEqual([]);
  });

  it.each([
    ['a future date', 'once', { local_date: '2026-10-30' }, '/local_date', 'must not be in the future'],
    ['a date 8 days back', 'once', { local_date: '2026-10-21' }, '/local_date', 'must be at most 7 days back'],
    ['a value on a one-time quest', 'once', { local_date: TODAY, value: '1' }, '/value', 'is only for target quests'],
    ['no value on a target quest', 'target', { local_date: TODAY }, '/value', 'is required for a target quest'],
    [
      'a value beyond 10^9',
      'target',
      { local_date: TODAY, value: '1000000000.001' },
      '/value',
      'must lie within ±1000000000',
    ],
    [
      'today on a habit not begun yet',
      'later',
      { local_date: TODAY },
      '/local_date',
      'cannot count before the habit’s start date',
    ],
  ] as const)(
    'refuses %s with 422 and stores nothing [R-CHK-04, R-CHK-05, A-05, A-36]',
    async (_case, name, body, pointer, message) => {
      const user = await goalUser(ctx);
      const achievementId = await achievementOf(user);
      const quests = {
        once: await createQuest(user, achievementId),
        target: await createQuest(user, achievementId, {
          type: 'target',
          target: { start_value: '0', target_value: '5' },
        }),
        later: await createQuest(user, achievementId, {
          type: 'habit',
          habit: { period: 'day', times_per_period: 1, period_count: 3, start_date: '2026-10-30' },
        }),
      };

      const response = await checkIn(user, quests[name].id, body);

      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        type: 'urn:questline:problem:unprocessable',
        errors: [{ pointer, message }],
      });
      expect(await storedCheckIns(quests[name].id)).toEqual([]);
    },
  );

  it('keeps a back-dated check-in on a habit not begun yet as history [A-36]', async () => {
    const user = await goalUser(ctx);
    const habit = await createQuest(user, await achievementOf(user), {
      type: 'habit',
      habit: { period: 'day', times_per_period: 1, period_count: 3, start_date: '2026-10-30' },
    });

    expect((await checkIn(user, habit.id, { local_date: '2026-10-28' })).json()).toMatchObject({
      check_in: { counts_for_progress: false },
    });
  });

  it.each([
    ['no date', {}],
    ['a malformed date', { local_date: '29.10.2026' }],
    ['a value with 4 decimals', { local_date: TODAY, value: '1.2345' }],
    ['a numeric value', { local_date: TODAY, value: 1 }],
    ['a note over 500 characters', { local_date: TODAY, note: 'x'.repeat(501) }],
    ['whether it counts', { local_date: TODAY, counts_for_progress: true }],
    ['an attempt', { local_date: TODAY, attempt: 2 }],
  ])('refuses a check-in with %s with 400 [R-IN-01, R-AUTHZ-04]', async (_case, body) => {
    const user = await goalUser(ctx);
    const quest = await createQuest(user, await achievementOf(user));

    const response = await checkIn(user, quest.id, body);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ type: 'urn:questline:problem:validation' });
  });

  it('answers 404 for another user’s, an unknown or a malformed ID [R-AUTHZ-02]', async () => {
    const owner = await goalUser(ctx);
    const intruder = await goalUser(ctx);
    const quest = await createQuest(owner, await achievementOf(owner));
    const mine = (await checkIn(owner, quest.id, { local_date: '2026-10-28' })).json<CheckInResult>().check_in;

    for (const [user, id] of [
      [intruder, quest.id],
      [owner, randomUUID()],
      [owner, 'not-a-uuid'],
    ] as const) {
      expect((await checkIn(user, id)).statusCode).toBe(404);
      expect((await listCheckIns(user, id)).statusCode).toBe(404);
    }
    for (const [user, id] of [
      [intruder, mine.id],
      [owner, randomUUID()],
      [owner, 'not-a-uuid'],
    ] as const) {
      expect((await undo(user, id)).statusCode).toBe(404);
    }
    expect(await storedCheckIns(quest.id)).toHaveLength(1);
  });

  it('refuses a check-in without the goal-content consent with 403 [R-PRIV-04]', async () => {
    const user = await goalUser(ctx);
    const quest = await createQuest(user, await achievementOf(user));
    await contractInject(ctx.app, {
      method: 'DELETE',
      url: '/v1/me/consents/goal_content',
      headers: bearer(user.token),
    });

    const refused = await checkIn(user, quest.id);

    // Withdrawing the consent deleted the goal content too (Q-10): the consent check comes first.
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ type: 'urn:questline:problem:consent-required' });
  });

  it('replays a repeated check-in and refuses its key for another body [ADR-0008]', async () => {
    const user = await goalUser(ctx);
    const quest = await createQuest(user, await achievementOf(user));
    const key = randomUUID();
    const first = await checkIn(user, quest.id, { local_date: '2026-10-28' }, key);

    const replay = await checkIn(user, quest.id, { local_date: '2026-10-28' }, key);
    const reused = await checkIn(user, quest.id, { local_date: '2026-10-27' }, key);

    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    expect(reused.statusCode).toBe(422);
    expect(await storedCheckIns(quest.id)).toHaveLength(1);
  });

  it('credits each of ten simultaneous check-ins on different quests once, one after another [T-06]', async () => {
    const user = await goalUser(ctx);
    const achievementId = await achievementOf(user);
    const quests: Resource[] = [];
    for (let index = 0; index < 10; index += 1) {
      quests.push(await createQuest(user, achievementId, { title: `Quest ${String(index)}` }));
    }
    await createQuest(user, achievementId, { title: 'Keeps the achievement open' });

    const responses = await Promise.all(quests.map((quest) => checkIn(user, quest.id)));

    expect(responses.map((response) => response.statusCode)).toEqual(quests.map(() => 201));
    // Under the user's goal lock each check-in sees the ones before it: the totals they report are 25, 50 … 250.
    const totals = responses.map((response) => response.json<CheckInResult>()['xp_total'] as number);
    expect(totals.toSorted((a, b) => a - b)).toEqual(quests.map((_, index) => 25 * (index + 1)));
    expect(await ledger(user.userId)).toEqual(quests.map(() => ({ kind: 'quest_completed', amount: 25 })));
    expect(await get(user, '/v1/me')).toMatchObject({ xp_total: 250 });
    expect(await get(user, `/v1/achievements/${achievementId}`)).toMatchObject({ status: 'active', xp_earned: 250 });
  });

  it('accepts 50 check-ins of a quest dated one day and refuses the 51st with 422 limit-reached [R-IN-01, A-42]', async () => {
    const user = await goalUser(ctx);
    const quest = await createQuest(user, await achievementOf(user));
    await withGoals(deps, user.userId, async (scope) => {
      const checkIns = checkInsRepository(scope.tx, user.userId, scope.dataKey);
      for (let count = 0; count < 49; count += 1) {
        await checkIns.insert(
          { questId: quest.id, localDate: '2026-10-28', attempt: 1, countsForProgress: false, value: null, note: null },
          scope.now,
        );
      }
    });

    expect((await checkIn(user, quest.id, { local_date: '2026-10-28' })).statusCode).toBe(201);
    const refused = await checkIn(user, quest.id, { local_date: '2026-10-28' });
    const otherDay = await checkIn(user, quest.id, { local_date: '2026-10-27' });

    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ type: 'urn:questline:problem:limit-reached' });
    expect(otherDay.statusCode).toBe(201);
  });

  it('lists a quest’s check-ins newest first in cursor pages, history included [R-IN-01, R-CHK-04]', async () => {
    const user = await goalUser(ctx);
    const quest = await createQuest(user, await achievementOf(user));
    const created: string[] = [];
    for (const localDate of ['2026-10-25', '2026-10-26', '2026-10-27', TODAY]) {
      created.push((await checkIn(user, quest.id, { local_date: localDate })).json<CheckInResult>().check_in.id);
      ctx.clock.advance({ milliseconds: 1 });
    }

    const first = await listCheckIns(user, quest.id, '?limit=3');
    const cursor = first.json<{ next_cursor: string }>().next_cursor;
    const second = await listCheckIns(user, quest.id, `?limit=3&cursor=${cursor}`);

    expect(first.statusCode).toBe(200);
    expect(first.json<{ items: Resource[] }>().items.map((item) => item.id)).toEqual(created.slice(1).reverse());
    expect(second.json()).toMatchObject({ items: [{ id: created[0], counts_for_progress: false }], next_cursor: null });
    expect((await listCheckIns(user, quest.id, '?cursor=bogus')).statusCode).toBe(400);
  });

  it('undoes a check-in made today and reverses all its effects: re-lock, rank, badge, XP [R-CHK-03, R-ACH-05, R-RANK-04]', async () => {
    const user = await goalUser(ctx);
    const achievementId = await achievementOf(user);
    const quest = await createQuest(user, achievementId);
    const made = (await checkIn(user, quest.id)).json<CheckInResult>();

    const response = await undo(user, made.check_in.id);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      quest: { id: quest.id, state: 'available', progress: 0, completed_at: null },
      achievement: { status: 'active', rank: null, execution_score: null, completed_at: null, xp_earned: 0 },
      xp_delta: -25,
      xp_total: 0,
      achievement_unlocked: false,
      achievement_relocked: true,
      rank: null,
      gamble: null,
    });
    expect(await storedCheckIns(quest.id)).toEqual([]);
    expect(await ctx.admin.sql`select id from badges where achievement_id = ${achievementId}`).toHaveLength(0);
    expect(await ledger(user.userId)).toEqual([
      { kind: 'quest_completed', amount: 25 },
      { kind: 'quest_uncompleted', amount: -25 },
    ]);
  });

  it('undoes a check-in only on the day it was made, whatever its date; later → 409 check-in-final [Q-36]', async () => {
    let user = await goalUser(ctx);
    const quest = await createQuest(user, await achievementOf(user));
    const first = (await checkIn(user, quest.id, { local_date: '2026-10-27' })).json<CheckInResult>();
    const second = (await checkIn(user, quest.id, { local_date: '2026-10-28' })).json<CheckInResult>();

    expect((await undo(user, first.check_in.id)).statusCode).toBe(200);
    user = await afterDays(user, 1);
    const refused = await undo(user, second.check_in.id);

    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ type: 'urn:questline:problem:check-in-final' });
    expect(await storedCheckIns(quest.id)).toHaveLength(1);
  });

  it('returns a gamble won by the undone unlock to pending [R-ACH-05, R-GMB-02]', async () => {
    const user = await goalUser(ctx);
    const achievementId = await achievementOf(user, { title: 'Bet', target_date: '2026-11-30' });
    const quest = await createQuest(user, achievementId);
    await giveXp(user.userId, 150);
    const gambleId = await pendingGamble(user.userId, achievementId, 30);
    const made = (await checkIn(user, quest.id)).json<CheckInResult>();
    expect(made).toMatchObject({ gamble: { gamble_id: gambleId, outcome: 'won', loss_reason: null } });

    const undone = await undo(user, made.check_in.id);

    expect(undone.json()).toMatchObject({
      achievement_relocked: true,
      gamble: { gamble_id: gambleId, outcome: 'reverted', loss_reason: null },
    });
    expect(await gambleStatus(gambleId)).toBe('pending');
  });

  it('refuses an undo that would make a second gamble pending with 409 gamble-pending, changing nothing [Q-43]', async () => {
    const user = await goalUser(ctx);
    const achievementId = await achievementOf(user, { title: 'Bet', target_date: '2026-11-30' });
    const quest = await createQuest(user, achievementId);
    await giveXp(user.userId, 150);
    const won = await pendingGamble(user.userId, achievementId, 30);
    const made = (await checkIn(user, quest.id)).json<CheckInResult>();
    const other = await pendingGamble(user.userId, await achievementOf(user, { title: 'Next bet' }), 30);

    const refused = await undo(user, made.check_in.id);

    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ type: 'urn:questline:problem:gamble-pending' });
    expect(await storedCheckIns(quest.id)).toHaveLength(1);
    expect(await get(user, `/v1/achievements/${achievementId}`)).toMatchObject({ status: 'completed' });
    expect([await gambleStatus(won), await gambleStatus(other)]).toEqual(['won', 'pending']);
  });
});
