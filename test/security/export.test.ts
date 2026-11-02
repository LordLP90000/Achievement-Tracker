import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startAccountsApp, TEST_PASSWORD, type AccountsApp } from '../helpers/accounts-app.ts';
import { contractInject } from '../helpers/contract.ts';
import { bearer, createAchievement, goalUser, loggedInAgain, type GoalUser } from '../helpers/goals.ts';

const START = '2026-10-29T12:00:00Z';
const HOUR_S = 3600;

/**
 * The data export (R-PRIV-05) is the most complete copy of an account the API hands out, so it needs the password
 * entered within 10 minutes, happens at most twice in any 24 hours and is audited [I-12, D-09, E-03, R-LOG-03].
 */
describe('data export guards [R-PRIV-05, R-AUTH-06, I-12, D-09, E-03, R-LOG-03]', () => {
  let ctx: AccountsApp;

  const exportOf = (user: GoalUser) =>
    contractInject(ctx.app, { method: 'GET', url: '/v1/me/export', headers: bearer(user.token) });
  const exportEvents = async (userId: string) =>
    (
      await ctx.admin.sql<{ outcome: string; session_id: string; ip_prefix: string | null; client: string | null }[]>`
        select outcome, session_id, ip_prefix::text as ip_prefix, client from audit_events
        where user_id = ${userId} and event_type = 'export_requested' order by created_at`
    ).map((row) => ({ ...row }));
  /** The clock moved past the access token's lifetime: a new login, which also counts as entering the password. */
  const later = (user: GoalUser, duration: { hours?: number; minutes?: number; seconds?: number }) => {
    ctx.clock.advance(duration);
    return loggedInAgain(ctx, user);
  };

  beforeAll(async () => {
    ctx = await startAccountsApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(() => {
    ctx.clock.set(START);
  });

  it('needs the password entered within 10 minutes: later → 403 until the user re-authenticates [R-AUTH-06, E-03]', async () => {
    const user = await goalUser(ctx);
    expect((await exportOf(user)).statusCode).toBe(200);
    ctx.clock.advance({ minutes: 10 });

    const stale = await exportOf(user);
    const reauthenticated = await ctx.post('/v1/auth/reauth', { password: TEST_PASSWORD }, bearer(user.token));
    const fresh = await exportOf(user);

    expect(stale.statusCode).toBe(403);
    expect(stale.json()).toMatchObject({ type: 'urn:questline:problem:reauthentication-required' });
    expect([reauthenticated.statusCode, fresh.statusCode]).toEqual([204, 200]);
  });

  it('allows two exports in any 24 hours: the third → 429 until the first one is 24 hours old, across midnight [D-09]', async () => {
    let user = await goalUser(ctx);
    expect((await exportOf(user)).statusCode).toBe(200);
    user = await later(user, { hours: 1 });
    expect((await exportOf(user)).statusCode).toBe(200);
    user = await later(user, { hours: 1 });

    const third = await exportOf(user);

    expect(third.statusCode).toBe(429);
    expect(third.headers['retry-after']).toBe(String(22 * HOUR_S));
    expect(third.json()).toMatchObject({ type: 'urn:questline:problem:rate-limited' });
    // The next UTC day changes nothing: only the first export's age does.
    user = await later(user, { hours: 21, minutes: 59, seconds: 59 });
    const justBefore = await exportOf(user);
    expect([justBefore.statusCode, justBefore.headers['retry-after']]).toEqual([429, '1']);
    user = await later(user, { seconds: 1 });
    expect((await exportOf(user)).statusCode).toBe(200);
    expect(await exportEvents(user.userId)).toHaveLength(3);
  });

  it('counts simultaneous requests one at a time: after one export, of three at once exactly one succeeds', async () => {
    const user = await goalUser(ctx);
    await exportOf(user);

    const statuses = await Promise.all([1, 2, 3].map(async () => (await exportOf(user)).statusCode));

    expect(statuses.sort()).toEqual([200, 429, 429]);
    expect(await exportEvents(user.userId)).toHaveLength(2);
  });

  it('audits each export with its session and network, and no refused one [R-LOG-03, R-01]', async () => {
    const user = await goalUser(ctx);
    const [session] = await ctx.admin.sql<{ id: string }[]>`select id from sessions where user_id = ${user.userId}`;
    await exportOf(user);
    ctx.clock.advance({ minutes: 11 });
    expect((await exportOf(user)).statusCode).toBe(403);

    expect(await exportEvents(user.userId)).toEqual([
      { outcome: 'success', session_id: session?.id, ip_prefix: '127.0.0.0/24', client: null },
    ]);
  });

  it('answers with a file that no cache may keep [R-TLS-02, I-07]', async () => {
    const response = await exportOf(await goalUser(ctx));

    expect(response.headers['content-disposition']).toBe('attachment; filename="questline-export.json"');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['content-type']).toMatch(/^application\/json/);
  });

  it('holds only the requester’s data: nothing of another account appears [I-04, I-12]', async () => {
    const [mine, theirs] = [await goalUser(ctx), await goalUser(ctx)];
    const secret = `Their goal ${randomUUID()}`;
    await createAchievement(ctx, theirs.token, { title: secret });
    await createAchievement(ctx, mine.token, { title: 'Mine' });
    const [theirSession] = await ctx.admin.sql<{ id: string }[]>`
      select id from sessions where user_id = ${theirs.userId}`;

    const text = (await exportOf(mine)).body;

    for (const value of [theirs.userId, theirs.email, secret, theirSession?.id ?? 'missing']) {
      expect(text).not.toContain(value);
    }
    expect(text).toContain('Mine');
  });
});
