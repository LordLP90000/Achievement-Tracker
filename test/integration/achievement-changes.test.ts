import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { settleAsLost } from '../../src/domain/gamble.ts';
import { startAccountsApp, type AccountsApp } from '../helpers/accounts-app.ts';
import { contractInject } from '../helpers/contract.ts';
import { bearer, createAchievement, goalUser, loggedInAgain, type GoalUser } from '../helpers/goals.ts';

const START = '2026-10-29T12:00:00Z';
const TODAY = '2026-10-29'; // in Europe/Zurich, a Thursday

interface Resource {
  readonly id: string;
  readonly version: number;
  readonly [field: string]: unknown;
}

/** Editing, pausing, resuming and deleting achievements (contract tag `achievements`). */
describe('achievement edits, pause, resume and deletion [R-ACH-01/02/06/07/09, A-26, A-35, A-39, T-16]', () => {
  let ctx: AccountsApp;

  const achievementOf = async (user: GoalUser, body: Record<string, unknown> = { title: 'Goal' }) =>
    (await createAchievement(ctx, user.token, body)).json<Resource>();
  const createQuest = async (user: GoalUser, achievementId: string, body: Record<string, unknown> = {}) =>
    (
      await ctx.post(
        `/v1/achievements/${achievementId}/quests`,
        { title: 'Quest', type: 'one_time', size: 'M', ...body },
        { ...bearer(user.token), 'idempotency-key': randomUUID() },
      )
    ).json<Resource>();
  const checkIn = async (user: GoalUser, questId: string) => {
    const response = await ctx.post(
      `/v1/quests/${questId}/check-ins`,
      { local_date: ctx.clock.now().toISOString().slice(0, 10) },
      { ...bearer(user.token), 'idempotency-key': randomUUID() },
    );
    if (response.statusCode !== 201) throw new Error(`check-in refused: ${String(response.statusCode)}`);
  };
  const tag = (version: number) => `"${String(version)}"`;
  const patch = (user: GoalUser, achievementId: string, body: unknown, ifMatch?: string) =>
    contractInject(ctx.app, {
      method: 'PATCH',
      url: `/v1/achievements/${achievementId}`,
      headers: {
        ...bearer(user.token),
        'content-type': 'application/json',
        ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }),
      },
      payload: JSON.stringify(body),
    });
  const remove = (user: GoalUser, achievementId: string, ifMatch?: string) =>
    contractInject(ctx.app, {
      method: 'DELETE',
      url: `/v1/achievements/${achievementId}`,
      headers: { ...bearer(user.token), ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }) },
    });
  const get = (user: GoalUser, url: string) =>
    contractInject(ctx.app, { method: 'GET', url, headers: bearer(user.token) });
  const detail = async (user: GoalUser, achievementId: string) =>
    (await get(user, `/v1/achievements/${achievementId}`)).json<Resource & { quests: Resource[] }>();
  /** Moves the clock on; the access token has expired by then, so the user logs in again. */
  const afterDays = (user: GoalUser, days: number) => {
    ctx.clock.advance({ days });
    return loggedInAgain(ctx, user);
  };
  const deadline = async (user: GoalUser, achievementId: string) => {
    const [row] = await ctx.admin.sql<{ deadline_enc: Buffer | null }[]>`
      select deadline_enc from achievements where id = ${achievementId}`;
    const blob = row?.deadline_enc ?? null;
    return blob === null ? null : ctx.decrypt(user.userId, achievementId, 'deadline_enc', blob);
  };
  const ledger = async (userId: string) =>
    (
      await ctx.admin.sql<{ kind: string; amount: number; achievement_id: string | null }[]>`
        select kind, amount::int as amount, achievement_id from xp_events where user_id = ${userId}
        order by created_at, xmin::text::bigint, kind, amount`
    ).map((event) => ({ ...event }));
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
  const gamble = async (gambleId: string) =>
    (
      await ctx.admin.sql<{ status: string; loss_reason: string | null }[]>`
      select status, loss_reason from gambles where id = ${gambleId}`
    )[0];
  const xpTotal = async (user: GoalUser) => (await get(user, '/v1/me')).json<{ xp_total: number }>().xp_total;

  beforeAll(async () => {
    ctx = await startAccountsApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(() => {
    ctx.clock.set(START);
  });

  it('edits title, description, motivation, category and privacy, clears with null, and re-encrypts [R-ACH-01, R-ACH-02]', async () => {
    const user = await goalUser(ctx);
    const created = await achievementOf(user, {
      title: 'Old',
      description: 'Desc',
      motivation: 'Because',
      category: 'Health',
    });

    const response = await patch(
      user,
      created.id,
      { title: 'New', description: null, motivation: 'Why not', category: null, is_private: true, status: 'active' },
      tag(1),
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe('"2"');
    expect(response.json()).toEqual({
      ...created,
      title: 'New',
      description: null,
      motivation: 'Why not',
      category: null,
      is_private: true,
      version: 2,
    });
    const [row] = await ctx.admin.sql<{ title_enc: Buffer; description_enc: Buffer | null }[]>`
      select title_enc, description_enc from achievements where id = ${created.id}`;
    expect(row?.description_enc).toBeNull();
    expect(await ctx.decrypt(user.userId, created.id, 'title_enc', row?.title_enc ?? Buffer.alloc(0))).toBe('New');
  });

  it('moves the attempt’s deadline to an earlier target date only [A-35]', async () => {
    const user = await goalUser(ctx);
    const created = await achievementOf(user, { title: 'Goal', target_date: '2026-12-31' });

    const earlier = await patch(user, created.id, { target_date: '2026-12-15' }, tag(1));
    expect(await deadline(user, created.id)).toBe('2026-12-15');
    const later = await patch(user, created.id, { target_date: '2027-01-31' }, tag(2));
    expect(await deadline(user, created.id)).toBe('2026-12-15');
    const removed = await patch(user, created.id, { target_date: null }, tag(3));

    expect([earlier, later, removed].map((response) => response.json<Resource>()['target_date'])).toEqual([
      '2026-12-15',
      '2027-01-31',
      null,
    ]);
    expect(await deadline(user, created.id)).toBe('2026-12-15');
  });

  it('keeps the target date while a gamble is pending: 409 gamble-pending; other edits go through [A-26, T-17]', async () => {
    const user = await goalUser(ctx);
    const created = await achievementOf(user, { title: 'Bet', target_date: '2026-12-31' });
    await pendingGamble(user.userId, created.id, 10);

    for (const body of [
      { target_date: '2026-12-01' },
      { target_date: null },
      { title: 'x', target_date: '2027-01-01' },
    ]) {
      const refused = await patch(user, created.id, body, tag(1));
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ type: 'urn:questline:problem:gamble-pending' });
    }
    const renamed = await patch(user, created.id, { title: 'Renamed', target_date: '2026-12-31' }, tag(1));

    expect(renamed.json()).toMatchObject({ title: 'Renamed', target_date: '2026-12-31', version: 2 });
  });

  it('pauses: the pending gamble is lost, the attempt’s XP revoked, the quests reset, the check-ins kept [R-ACH-06, R-GMB-03, R-STR-01]', async () => {
    const user = await goalUser(ctx);
    const achievement = await achievementOf(user, { title: 'Run', target_date: '2026-12-31' });
    const once = await createQuest(user, achievement.id, { title: 'Shoes' });
    const habit = await createQuest(user, achievement.id, {
      type: 'habit',
      habit: { period: 'day', times_per_period: 1, period_count: 3 },
    });
    await giveXp(user.userId, 150);
    const gambleId = await pendingGamble(user.userId, achievement.id, 30);
    await checkIn(user, once.id);
    await checkIn(user, habit.id);

    const response = await patch(user, achievement.id, { status: 'paused' }, tag(1));

    expect(response.statusCode).toBe(200);
    const paused = response.json<Resource>();
    expect(response.headers.etag).toBe(tag(paused.version));
    expect(paused).toMatchObject({ status: 'paused', attempt: 1, progress: 0, xp_earned: 0 });
    const lost = settleAsLost(30, 175, 'paused').xpDelta;
    expect(await ledger(user.userId)).toEqual([
      { kind: 'quest_completed', amount: 150, achievement_id: null },
      { kind: 'quest_completed', amount: 25, achievement_id: achievement.id },
      { kind: 'gamble_lost', amount: lost, achievement_id: achievement.id },
      { kind: 'pause_revoked', amount: -25, achievement_id: achievement.id },
    ]);
    expect(await gamble(gambleId)).toEqual({ status: 'lost', loss_reason: 'paused' });
    expect((await detail(user, achievement.id)).quests).toMatchObject([
      { id: once.id, state: 'available', progress: 0, completed_at: null, reset_count: 0 },
      { id: habit.id, state: 'available', progress: 0, streak: { current: 0, best: 1, period: 'day' } },
    ]);
    expect(await ctx.admin.sql`select id from check_ins where quest_id in (${once.id}, ${habit.id})`).toHaveLength(2);
    expect(await xpTotal(user)).toBe(150 + lost);
  });

  it('resumes as the next attempt: earlier check-ins are history, habits start today, the deadline starts anew [R-ACH-06, A-35, A-39]', async () => {
    let user = await goalUser(ctx);
    const achievement = await achievementOf(user, { title: 'Run', target_date: '2026-12-31' });
    const once = await createQuest(user, achievement.id, { title: 'Shoes' });
    const habit = await createQuest(user, achievement.id, {
      type: 'habit',
      habit: { period: 'week', times_per_period: 2, period_count: 4 },
    });
    await checkIn(user, once.id);
    await patch(user, achievement.id, { target_date: '2026-12-15' }, tag(1));
    const paused = (await patch(user, achievement.id, { status: 'paused' }, tag(2))).json<Resource>();
    user = await afterDays(user, 4);
    await ctx.admin.sql`update users set week_start = 'sunday' where id = ${user.userId}`;
    const later = (
      await patch(user, achievement.id, { target_date: '2026-12-20' }, tag(paused.version))
    ).json<Resource>();
    expect(await deadline(user, achievement.id)).toBe('2026-12-15');

    const resumed = await patch(user, achievement.id, { status: 'active' }, tag(later.version));

    expect(resumed.json()).toMatchObject({ status: 'active', attempt: 2, progress: 0, xp_earned: 0 });
    expect(await deadline(user, achievement.id)).toBe('2026-12-20');
    const quests = (await detail(user, achievement.id)).quests;
    expect(quests).toMatchObject([
      { id: once.id, state: 'available', progress: 0 },
      {
        id: habit.id,
        habit: { start_date: '2026-11-02' },
        current_period: { start: '2026-11-02', end: '2026-11-14', check_ins: 0, required_check_ins: 2 },
      },
    ]);
    await checkIn(user, once.id);
    expect((await detail(user, achievement.id)).quests[0]).toMatchObject({ state: 'completed' });
  });

  it('leaves no XP behind through pause and resume loops [T-16, R-XP-01]', async () => {
    const user = await goalUser(ctx);
    const achievement = await achievementOf(user);
    const quest = await createQuest(user, achievement.id);
    await createQuest(user, achievement.id, { title: 'Keeps the achievement open' });
    let version = 1;

    for (let loop = 0; loop < 3; loop += 1) {
      await checkIn(user, quest.id);
      expect(await xpTotal(user)).toBe(25);
      version = (await patch(user, achievement.id, { status: 'paused' }, tag(version))).json<Resource>().version;
      expect(await xpTotal(user)).toBe(0);
      version = (await patch(user, achievement.id, { status: 'active' }, tag(version))).json<Resource>().version;
    }

    expect((await detail(user, achievement.id))['attempt']).toBe(4);
    expect((await ledger(user.userId)).map((event) => event.amount)).toEqual([25, -25, 25, -25, 25, -25]);
  });

  it('deletes an achievement: its XP revoked, a pending gamble lost, its quests, check-ins and gambles gone [R-ACH-09, Q-12]', async () => {
    const user = await goalUser(ctx);
    const achievement = await achievementOf(user, { title: 'Bet', target_date: '2026-12-31' });
    const quest = await createQuest(user, achievement.id);
    await createQuest(user, achievement.id, { title: 'Open' });
    await giveXp(user.userId, 150);
    await pendingGamble(user.userId, achievement.id, 30);
    await checkIn(user, quest.id);
    // The deletion rewrites these ledger rows (their reference is cleared), so only the time keeps their order.
    ctx.clock.advance({ milliseconds: 1 });

    const response = await remove(user, achievement.id, tag(1));

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe('');
    expect((await get(user, `/v1/achievements/${achievement.id}`)).statusCode).toBe(404);
    const lost = settleAsLost(30, 175, 'deleted').xpDelta;
    expect(await ledger(user.userId)).toEqual([
      { kind: 'quest_completed', amount: 150, achievement_id: null },
      { kind: 'quest_completed', amount: 25, achievement_id: null },
      { kind: 'achievement_deleted', amount: -25, achievement_id: null },
      { kind: 'gamble_lost', amount: lost, achievement_id: null },
    ]);
    for (const table of ['quests', 'check_ins', 'gambles', 'badges'] as const) {
      expect(await ctx.admin.sql`select 1 from ${ctx.admin.sql(table)} where user_id = ${user.userId}`).toEqual([]);
    }
    expect(await xpTotal(user)).toBe(150 + lost);
  });

  it('deletes a paused achievement, which has nothing left to revoke [R-ACH-09]', async () => {
    const user = await goalUser(ctx);
    const achievement = await achievementOf(user);
    const quest = await createQuest(user, achievement.id);
    await createQuest(user, achievement.id, { title: 'Open' });
    await checkIn(user, quest.id);
    ctx.clock.advance({ milliseconds: 1 });
    const paused = (await patch(user, achievement.id, { status: 'paused' }, tag(1))).json<Resource>();

    expect((await remove(user, achievement.id, tag(paused.version))).statusCode).toBe(204);
    expect((await ledger(user.userId)).map((event) => event.kind)).toEqual(['quest_completed', 'pause_revoked']);
  });

  it('refuses to edit, pause or delete a completed achievement with 409, whatever the version [R-ACH-07, Q-17]', async () => {
    const user = await goalUser(ctx);
    const achievement = await achievementOf(user);
    const quest = await createQuest(user, achievement.id);
    await checkIn(user, quest.id);

    for (const refused of [
      await patch(user, achievement.id, { title: 'Rewritten' }, tag(1)),
      await patch(user, achievement.id, { status: 'paused' }, tag(2)),
      await remove(user, achievement.id, tag(2)),
    ]) {
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toMatchObject({ type: 'urn:questline:problem:achievement-completed' });
    }
    expect(await detail(user, achievement.id)).toMatchObject({ title: 'Goal', status: 'completed' });
  });

  it('needs If-Match (428, 400, 409 with the current version) and answers 404 for any other ID [ADR-0008, R-AUTHZ-02]', async () => {
    const owner = await goalUser(ctx);
    const intruder = await goalUser(ctx);
    const achievement = await achievementOf(owner);

    expect((await patch(owner, achievement.id, { title: 'x' })).statusCode).toBe(428);
    expect((await remove(owner, achievement.id)).statusCode).toBe(428);
    expect((await patch(owner, achievement.id, { title: 'x' }, 'W/"1"')).statusCode).toBe(400);
    expect((await remove(owner, achievement.id, '*')).statusCode).toBe(400);
    expect((await patch(owner, achievement.id, { title: 'First' }, tag(1))).statusCode).toBe(200);
    for (const stale of [
      await patch(owner, achievement.id, { title: 'Second' }, tag(1)),
      await remove(owner, achievement.id, tag(1)),
    ]) {
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ type: 'urn:questline:problem:version-conflict', current_version: 2 });
    }
    for (const [user, id] of [
      [intruder, achievement.id],
      [owner, randomUUID()],
      [owner, 'not-a-uuid'],
    ] as const) {
      expect((await patch(user, id, { title: 'Stolen' }, tag(2))).statusCode).toBe(404);
      expect((await remove(user, id, tag(2))).statusCode).toBe(404);
    }
    expect(await detail(owner, achievement.id)).toMatchObject({ title: 'First', version: 2 });
  });

  it.each([
    ['an empty body', {}],
    ['the status completed', { status: 'completed' }],
    ['an attempt', { attempt: 2 }],
    ['XP', { xp_earned: 100 }],
    ['a rank', { rank: 'champion' }],
    ['an empty title', { title: '' }],
    ['a malformed target date', { target_date: '31.12.2026' }],
  ])('refuses an edit with %s with 400 [R-IN-01, R-AUTHZ-04, R-ACH-07]', async (_case, body) => {
    const user = await goalUser(ctx);
    const achievement = await achievementOf(user);

    const response = await patch(user, achievement.id, body, tag(1));

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ type: 'urn:questline:problem:validation' });
  });
});
