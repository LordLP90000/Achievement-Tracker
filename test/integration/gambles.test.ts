import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { xpAboveLevel, xpThreshold } from '../../src/domain/xp.ts';
import { startAccountsApp, type AccountsApp } from '../helpers/accounts-app.ts';
import { contractInject } from '../helpers/contract.ts';
import { bearer, createAchievement, goalUser, loggedInAgain, type GoalUser } from '../helpers/goals.ts';

const START = '2026-10-29T12:00:00Z';
const TODAY = '2026-10-29'; // in Europe/Zurich, a Thursday

interface Resource {
  readonly id: string;
  readonly [field: string]: unknown;
}

/** Gambles (contract tag `gambles`): placing one and listing them; settlement comes with the effects. */
describe('gambles [R-GMB-01…05, Q-31, A-20, A-21, A-27, T-17]', () => {
  let ctx: AccountsApp;

  const achievementOf = async (user: GoalUser, body: Record<string, unknown> = {}) =>
    (await createAchievement(ctx, user.token, { title: 'Goal', target_date: '2026-11-30', ...body })).json<Resource>();
  const createQuest = async (user: GoalUser, achievementId: string) =>
    (
      await ctx.post(
        `/v1/achievements/${achievementId}/quests`,
        { title: 'Quest', type: 'one_time', size: 'M' },
        { ...bearer(user.token), 'idempotency-key': randomUUID() },
      )
    ).json<Resource>();
  const place = (user: GoalUser, achievementId: string, body?: unknown, key = randomUUID()) =>
    contractInject(ctx.app, {
      method: 'POST',
      url: `/v1/achievements/${achievementId}/gambles`,
      headers: {
        ...bearer(user.token),
        'idempotency-key': key,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  const list = (user: GoalUser, achievementId: string, query = '') =>
    contractInject(ctx.app, {
      method: 'GET',
      url: `/v1/achievements/${achievementId}/gambles${query}`,
      headers: bearer(user.token),
    });
  const patch = (user: GoalUser, achievementId: string, body: unknown, version: number) =>
    contractInject(ctx.app, {
      method: 'PATCH',
      url: `/v1/achievements/${achievementId}`,
      headers: { ...bearer(user.token), 'content-type': 'application/json', 'if-match': `"${String(version)}"` },
      payload: JSON.stringify(body),
    });
  const giveXp = (userId: string, amount: number) =>
    ctx.admin.sql`
      insert into xp_events (id, user_id, kind, amount, local_date, created_at)
      values (${randomUUID()}, ${userId}, 'quest_completed', ${amount}, ${TODAY}, ${ctx.clock.now()})`;
  const xpTotal = async (user: GoalUser) =>
    (await contractInject(ctx.app, { method: 'GET', url: '/v1/me', headers: bearer(user.token) })).json<{
      xp_total: number;
    }>().xp_total;
  const storedGambles = (userId: string) =>
    ctx.admin.sql<{ status: string }[]>`select status from gambles where user_id = ${userId}`;

  beforeAll(async () => {
    ctx = await startAccountsApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(() => {
    ctx.clock.set(START);
  });

  it('places a gamble that stakes the XP above the level’s threshold, recorded but not removed [R-GMB-01, T-17]', async () => {
    const user = await goalUser(ctx);
    const achievement = await achievementOf(user);
    await giveXp(user.userId, 250);

    const response = await place(user, achievement.id);

    expect(response.statusCode).toBe(201);
    expect(xpAboveLevel(250)).toBeGreaterThan(0);
    expect(response.json()).toEqual({
      id: expect.any(String) as unknown,
      attempt: 1,
      stake: xpAboveLevel(250),
      status: 'pending',
      loss_reason: null,
      placed_at: ctx.clock.now().toISOString(),
      settled_at: null,
    });
    expect(await xpTotal(user)).toBe(250);
  });

  it('accepts an empty body but no field of its own: the stake and status are the server’s [R-AUTHZ-04, T-17]', async () => {
    const user = await goalUser(ctx);
    await giveXp(user.userId, 250);

    expect((await place(user, (await achievementOf(user)).id, {})).statusCode).toBe(201);
    for (const body of [{ stake: 1000 }, { status: 'won' }, []]) {
      const refused = await place(user, (await achievementOf(user)).id, body);
      expect(refused.statusCode).toBe(400);
    }
    expect(await storedGambles(user.userId)).toHaveLength(1);
  });

  it('refuses with 409 an achievement that is not active or has no target date after today [R-GMB-01]', async () => {
    const user = await goalUser(ctx);
    await giveXp(user.userId, 250);
    const paused = await achievementOf(user);
    await patch(user, paused.id, { status: 'paused' }, 1);
    const completed = await achievementOf(user);
    const done = await createQuest(user, completed.id);
    await ctx.post(
      `/v1/quests/${done.id}/check-ins`,
      { local_date: TODAY },
      { ...bearer(user.token), 'idempotency-key': randomUUID() },
    );

    const refusals = [
      [paused.id, 'achievement-not-active'],
      [completed.id, 'achievement-not-active'],
      [(await achievementOf(user, { target_date: undefined })).id, 'gamble-target-date-required'],
      [(await achievementOf(user, { target_date: TODAY })).id, 'gamble-target-date-required'],
    ] as const;
    for (const [achievementId, slug] of refusals) {
      const refused = await place(user, achievementId);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ type: `urn:questline:problem:${slug}` });
    }
    expect(await storedGambles(user.userId)).toEqual([]);
  });

  it('allows one pending gamble per user, across achievements, and none after a loss in the same attempt [Q-31, A-27]', async () => {
    const user = await goalUser(ctx);
    await giveXp(user.userId, 250);
    const first = await achievementOf(user);
    const second = await achievementOf(user);
    expect((await place(user, first.id)).statusCode).toBe(201);

    const pending = await place(user, second.id);
    await ctx.admin.sql`update gambles set status = 'lost', loss_reason = 'habit_reset', settled_at = ${ctx.clock.now()}
      where user_id = ${user.userId}`;
    const lostThisAttempt = await place(user, first.id);

    expect(pending.json()).toMatchObject({ type: 'urn:questline:problem:gamble-pending' });
    expect(lostThisAttempt.json()).toMatchObject({ type: 'urn:questline:problem:gamble-lost-this-attempt' });
    expect((await place(user, second.id)).statusCode).toBe(201);
  });

  it('refuses a gamble with nothing to stake with 422 [R-GMB-01]', async () => {
    const user = await goalUser(ctx);
    await giveXp(user.userId, xpThreshold(2));

    const refused = await place(user, (await achievementOf(user)).id);

    expect(refused.statusCode).toBe(422);
    expect(refused.json()).toMatchObject({ type: 'urn:questline:problem:nothing-to-stake' });
  });

  it('shows a gamble lost since the last request: its target date has passed [A-20, A-21]', async () => {
    let user = await goalUser(ctx);
    await giveXp(user.userId, 250);
    const missed = await achievementOf(user, { target_date: '2026-10-30' });
    const gamble = (await place(user, missed.id)).json<Resource>();
    ctx.clock.advance({ days: 2 });
    user = await loggedInAgain(ctx, user);

    const listed = await list(user, missed.id);

    expect(listed.json()).toMatchObject({
      items: [
        { id: gamble.id, status: 'lost', loss_reason: 'target_date_passed', settled_at: ctx.clock.now().toISOString() },
      ],
    });
  });

  it('settles a pending gamble whose target date has passed before placing another [A-20, A-21, R-GMB-03]', async () => {
    let user = await goalUser(ctx);
    await giveXp(user.userId, 250);
    const missed = await achievementOf(user, { target_date: '2026-10-30' });
    const next = await achievementOf(user);
    await place(user, missed.id);
    // More XP than the loss can take, so something is left to stake (Q-31).
    await giveXp(user.userId, 1000);
    ctx.clock.advance({ days: 2 });
    user = await loggedInAgain(ctx, user);

    const placed = await place(user, next.id);

    expect(placed.statusCode).toBe(201);
    const lost = (await list(user, missed.id)).json<{ items: Resource[] }>().items;
    expect(lost).toMatchObject([{ status: 'lost', loss_reason: 'target_date_passed' }]);
    expect(placed.json()).toMatchObject({ stake: xpAboveLevel(await xpTotal(user)) });
  });

  it('pays a win on an unlock by the target date, at most the required XP [R-GMB-02, Q-31]', async () => {
    let user = await goalUser(ctx);
    await giveXp(user.userId, 250);
    const achievement = await achievementOf(user);
    const quest = await createQuest(user, achievement.id);
    const gamble = (await place(user, achievement.id)).json<Resource>();
    ctx.clock.advance({ days: 8 });
    user = await loggedInAgain(ctx, user);

    const unlocked = await ctx.post(
      `/v1/quests/${quest.id}/check-ins`,
      { local_date: '2026-11-06' },
      { ...bearer(user.token), 'idempotency-key': randomUUID() },
    );

    const paid = Math.min(gamble['stake'] as number, 25);
    expect(unlocked.json()).toMatchObject({
      achievement_unlocked: true,
      gamble: { gamble_id: gamble.id, outcome: 'won', xp_delta: paid, loss_reason: null },
    });
    expect((await list(user, achievement.id)).json()).toMatchObject({ items: [{ id: gamble.id, status: 'won' }] });
  });

  it('lists an achievement’s gambles of every attempt, newest first, in cursor pages [R-GMB-04, R-IN-01]', async () => {
    const user = await goalUser(ctx);
    await giveXp(user.userId, 250);
    const achievement = await achievementOf(user);
    const first = (await place(user, achievement.id)).json<Resource>();
    const paused = (await patch(user, achievement.id, { status: 'paused' }, 1)).json<{ version: number }>();
    await patch(user, achievement.id, { status: 'active' }, paused.version);
    // The loss took all XP above the level's threshold (Q-31): something new to stake.
    await giveXp(user.userId, 100);
    ctx.clock.advance({ milliseconds: 1 });
    const second = (await place(user, achievement.id)).json<Resource>();

    const page = await list(user, achievement.id, '?limit=1');
    const cursor = page.json<{ next_cursor: string }>().next_cursor;
    const rest = await list(user, achievement.id, `?limit=1&cursor=${cursor}`);

    expect(page.json()).toMatchObject({ items: [{ id: second.id, attempt: 2, status: 'pending' }] });
    expect(rest.json()).toMatchObject({
      items: [{ id: first.id, attempt: 1, status: 'lost', loss_reason: 'paused' }],
      next_cursor: null,
    });
    expect((await list(user, achievement.id, '?limit=0')).statusCode).toBe(400);
  });

  it('replays a repeated placement and refuses its key for another achievement [ADR-0008]', async () => {
    const user = await goalUser(ctx);
    await giveXp(user.userId, 250);
    const achievement = await achievementOf(user);
    const key = randomUUID();
    const first = await place(user, achievement.id, undefined, key);

    const replay = await place(user, achievement.id, undefined, key);
    const reused = await place(user, (await achievementOf(user)).id, undefined, key);

    expect(replay.headers['idempotency-replayed']).toBe('true');
    expect(replay.json()).toEqual(first.json());
    expect(reused.statusCode).toBe(422);
    expect(await storedGambles(user.userId)).toHaveLength(1);
  });

  it('answers 404 for another user’s, an unknown or a malformed achievement [R-AUTHZ-02]', async () => {
    const owner = await goalUser(ctx);
    const intruder = await goalUser(ctx);
    await giveXp(intruder.userId, 250);
    const achievement = await achievementOf(owner);

    for (const [user, id] of [
      [intruder, achievement.id],
      [owner, randomUUID()],
      [owner, 'not-a-uuid'],
    ] as const) {
      expect((await place(user, id)).statusCode).toBe(404);
      expect((await list(user, id)).statusCode).toBe(404);
    }
    expect(await storedGambles(intruder.userId)).toEqual([]);
  });

  it('places exactly one of ten simultaneous gambles on different achievements [Q-31, T-17]', async () => {
    const user = await goalUser(ctx);
    await giveXp(user.userId, 250);
    const achievements = await Promise.all(Array.from({ length: 10 }, () => achievementOf(user)));

    const responses = await Promise.all(achievements.map((achievement) => place(user, achievement.id)));

    const statuses = responses.map((response) => response.statusCode).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409, 409, 409, 409, 409]);
    expect(await storedGambles(user.userId)).toEqual([{ status: 'pending' }]);
  });
});
