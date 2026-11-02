import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startAccountsApp, TEST_PASSWORD, type AccountsApp } from '../helpers/accounts-app.ts';
import { contractInject } from '../helpers/contract.ts';
import { bearer, goalUser, loggedInAgain, type GoalUser } from '../helpers/goals.ts';

const START = '2026-10-29T12:00:00Z';
const START_MS = Date.parse(START);

interface TokenPair {
  readonly access_token: string;
  readonly refresh_token: string;
}

/**
 * `DELETE /v1/me` (R-PRIV-06, Q-11): the account is deactivated at once — every session and emailed link ends, the
 * request is audited and the owner is told the deadline — and only a password login within 30 days brings it back.
 */
describe('account deletion request [R-PRIV-06, R-AUTH-06, E-13, A-22]', () => {
  let ctx: AccountsApp;

  const deleteAccount = (token: string) =>
    contractInject(ctx.app, { method: 'DELETE', url: '/v1/me', headers: bearer(token) });
  const me = (token: string) => contractInject(ctx.app, { method: 'GET', url: '/v1/me', headers: bearer(token) });
  const login = (email: string, password = TEST_PASSWORD) =>
    ctx.post('/v1/auth/login', { email, password, client: 'android' });
  const accountOf = async (userId: string) =>
    (
      await ctx.admin.sql<{ deactivated_ms: number | null; version: number }[]>`
        select extract(epoch from deactivated_at)::float8 * 1000 as deactivated_ms, version
        from users where id = ${userId}`
    ).map((row) => ({ ...row }));
  const sessionsOf = async (userId: string) =>
    (
      await ctx.admin.sql<{ revoked_ms: number | null; revoked_reason: string | null }[]>`
        select extract(epoch from revoked_at)::float8 * 1000 as revoked_ms, revoked_reason
        from sessions where user_id = ${userId} order by created_at`
    ).map((row) => ({ ...row }));
  const tokensOf = async (userId: string) => {
    const [row] = await ctx.admin.sql<{ session_tokens: number; one_time_tokens: number }[]>`
      select (select count(*)::int from session_tokens where user_id = ${userId}) as session_tokens,
        (select count(*)::int from one_time_tokens where user_id = ${userId}) as one_time_tokens`;
    return { ...row };
  };
  const eventsOf = async (userId: string, type: string) =>
    (
      await ctx.admin.sql<{ outcome: string; session_id: string | null; ip_prefix: string | null; client: null }[]>`
        select outcome, session_id, ip_prefix::text as ip_prefix, client from audit_events
        where user_id = ${userId} and event_type = ${type} order by created_at`
    ).map((row) => ({ ...row }));
  const noticesOf = async (userId: string) =>
    (await ctx.emails())
      .filter((email) => email.userId === userId && email.template === 'account_deleted_notice')
      .map((email) => email.payload);
  const linkTo = async (email: string, template: string) =>
    (await ctx.emails()).findLast((queued) => queued.payload.to === email && queued.template === template)?.payload
      .token ?? 'missing';
  const sessionIdOf = async (userId: string) =>
    (await ctx.admin.sql<{ id: string }[]>`select id from sessions where user_id = ${userId}`)[0]?.id;
  /** API connections of this test database that wait for a row lock. */
  const waitingForLocks = async () => {
    const [row] = await ctx.admin.sql<{ count: string }[]>`
      select count(*) from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and usename = 'questline_app'`;
    return Number(row?.count);
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

  it('deactivates the account at once: 202 with the deadline 30 days on, audited, the owner told [R-PRIV-06, R-LOG-03]', async () => {
    const user = await goalUser(ctx);
    const sessionId = await sessionIdOf(user.userId);

    const response = await deleteAccount(user.token);

    expect(response.statusCode).toBe(202);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ deletion_scheduled_for: '2026-11-28T12:00:00.000Z' });
    expect(await accountOf(user.userId)).toEqual([{ deactivated_ms: START_MS, version: 3 }]);
    expect(await eventsOf(user.userId, 'account_deleted')).toEqual([
      { outcome: 'success', session_id: sessionId, ip_prefix: '127.0.0.0/24', client: null },
    ]);
    expect(await noticesOf(user.userId)).toEqual([{ to: user.email, locale: 'de-CH' }]);
  });

  it('ends every session of the account on every device: its access and refresh tokens → 401 [E-13, R-AUTH-05]', async () => {
    const user = await goalUser(ctx);
    const phone = (await login(user.email)).json<TokenPair>();
    const bystander = await goalUser(ctx);

    expect((await deleteAccount(user.token)).statusCode).toBe(202);

    expect(await sessionsOf(user.userId)).toEqual([
      { revoked_ms: START_MS, revoked_reason: 'account_deleted' },
      { revoked_ms: START_MS, revoked_reason: 'account_deleted' },
    ]);
    expect((await tokensOf(user.userId)).session_tokens).toBe(0);
    expect([(await me(user.token)).statusCode, (await me(phone.access_token)).statusCode]).toEqual([401, 401]);
    const refreshed = await ctx.post('/v1/auth/refresh', { refresh_token: phone.refresh_token });
    expect([refreshed.statusCode, refreshed.json()]).toMatchObject([
      401,
      { type: 'urn:questline:problem:invalid-token' },
    ]);
    expect((await me(bystander.token)).statusCode).toBe(200);
  });

  it('voids every emailed link of the account: a pending reset, email change or verification link → 401 [E-13, A-22]', async () => {
    const user = await goalUser(ctx);
    const verification = await linkTo(user.email, 'verify_email');
    const newAddress = `moved-${randomUUID().slice(0, 8)}@example.test`;
    expect((await ctx.post('/v1/auth/password/forgot', { email: user.email })).statusCode).toBe(202);
    expect((await ctx.post('/v1/me/email-change', { new_email: newAddress }, bearer(user.token))).statusCode).toBe(202);
    const [reset, change] = [
      await linkTo(user.email, 'password_reset'),
      await linkTo(newAddress, 'email_change_verify'),
    ];

    expect((await deleteAccount(user.token)).statusCode).toBe(202);

    expect(await tokensOf(user.userId)).toEqual({ session_tokens: 0, one_time_tokens: 0 });
    const answers = [
      await ctx.post('/v1/auth/password/reset', { token: reset, new_password: 'a brand new passphrase here' }),
      await ctx.post('/v1/me/email-change/confirm', { token: change }),
      await ctx.post('/v1/auth/verify-email', { token: verification }),
    ];
    expect(answers.map((answer) => answer.statusCode)).toEqual([401, 401, 401]);
    expect(await accountOf(user.userId)).toEqual([{ deactivated_ms: START_MS, version: 3 }]);
  });

  it('needs the password entered within 10 minutes: later → 403 and nothing changes, until the user re-authenticates [R-AUTH-06, E-03]', async () => {
    const user = await goalUser(ctx);
    ctx.clock.advance({ minutes: 10 });

    const stale = await deleteAccount(user.token);

    expect(stale.statusCode).toBe(403);
    expect(stale.json()).toMatchObject({ type: 'urn:questline:problem:reauthentication-required' });
    expect(await accountOf(user.userId)).toEqual([{ deactivated_ms: null, version: 2 }]);
    expect(await sessionsOf(user.userId)).toEqual([{ revoked_ms: null, revoked_reason: null }]);
    expect(await eventsOf(user.userId, 'account_deleted')).toEqual([]);
    expect(await noticesOf(user.userId)).toEqual([]);
    expect((await ctx.post('/v1/auth/reauth', { password: TEST_PASSWORD }, bearer(user.token))).statusCode).toBe(204);
    expect((await deleteAccount(user.token)).statusCode).toBe(202);
  });

  it('deletes once when asked from several devices at the same time: one 202, the others 401 [E-13]', async () => {
    const user = await goalUser(ctx);
    const devices: GoalUser[] = [user, await loggedInAgain(ctx, user), await loggedInAgain(ctx, user)];
    // Hold the account row until every request waits for it, so they truly race (deterministic, no sleeps).
    const { promise: released, resolve: release } = Promise.withResolvers<undefined>();
    const { promise: isLocked, resolve: locked } = Promise.withResolvers<undefined>();
    const holder = ctx.admin.sql.begin(async (tx) => {
      await tx`select id from users where id = ${user.userId} for update`;
      locked(undefined);
      await released;
    });
    await isLocked;

    const racing = Promise.all(devices.map((device) => deleteAccount(device.token)));
    await expect.poll(waitingForLocks, { timeout: 5000, interval: 10 }).toBe(devices.length);
    release(undefined);
    await holder;
    const statuses = (await racing).map((response) => response.statusCode);

    expect(statuses.sort()).toEqual([202, 401, 401]);
    expect(await eventsOf(user.userId, 'account_deleted')).toHaveLength(1);
    expect(await noticesOf(user.userId)).toHaveLength(1);
  });

  it('answers a wrong password like an unknown address, and the right one within 30 days reactivates [R-AUTH-07, E-13]', async () => {
    const user = await goalUser(ctx);
    expect((await deleteAccount(user.token)).statusCode).toBe(202);
    const withoutId = (body: Record<string, unknown>) => ({ ...body, request_id: undefined });

    const wrong = await login(user.email, 'not the password at all');
    const unknown = await login(`nobody-${randomUUID().slice(0, 8)}@example.test`, 'not the password at all');
    ctx.clock.advance({ days: 29, hours: 23, minutes: 59, seconds: 59 });
    const right = await login(user.email);

    expect([wrong.statusCode, unknown.statusCode]).toEqual([401, 401]);
    expect(withoutId(wrong.json<Record<string, unknown>>())).toEqual(
      withoutId(unknown.json<Record<string, unknown>>()),
    );
    expect(right.statusCode).toBe(200);
    expect(await accountOf(user.userId)).toEqual([{ deactivated_ms: null, version: 4 }]);
    expect(await eventsOf(user.userId, 'account_reactivated')).toHaveLength(1);
    expect((await me(right.json<TokenPair>().access_token)).statusCode).toBe(200);
  });
});
