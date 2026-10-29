import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAccountsApp, type AccountsApp, type TestAccount } from '../helpers/accounts-app.ts';
import { contractInject } from '../helpers/contract.ts';

interface TokenPair {
  access_token: string;
  refresh_token: string;
  session_id: string;
}

describe('access tokens, logout and logout-all [R-AUTH-04, R-AUTH-05, R-AUTH-10, R-AUTHZ-01]', () => {
  let ctx: AccountsApp;

  const login = async (account: TestAccount): Promise<TokenPair> =>
    (await ctx.post('/v1/auth/login', { email: account.email, password: account.password, client: 'android' })).json();
  const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
  /** A test-only route behind the same guard as the API (registered by the test helper). */
  const whoami = (headers: Record<string, string>) =>
    ctx.app.inject({ method: 'GET', url: '/__test/v1/whoami', headers });
  const logout = (token: string, url = '/v1/auth/logout') =>
    contractInject(ctx.app, { method: 'POST', url, headers: bearer(token) });
  const sessionRow = async (sessionId: string) =>
    (await ctx.worker.sql<Record<string, unknown>[]>`select * from sessions where id = ${sessionId}`)[0];
  const tokenCount = async (sessionId: string) =>
    Number(
      (
        await ctx.worker.sql<{ count: string }[]>`select count(*) from session_tokens where session_id = ${sessionId}`
      )[0]?.count,
    );

  beforeAll(async () => {
    ctx = await startAccountsApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('authenticates a request with the access token and attaches the session, nothing more', async () => {
    const account = await ctx.account();
    const pair = await login(account);

    const response = await whoami(bearer(pair.access_token));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      userId: account.userId,
      sessionId: pair.session_id,
      lastReauthAt: ctx.clock.now().toISOString(),
    });
  });

  it.each([
    ['no Authorization header', {}],
    ['another scheme', { authorization: 'Basic dXNlcjpwYXNz' }],
    ['a scheme without a token', { authorization: 'Bearer' }],
    ['two spaces', { authorization: `Bearer  ql_at_${'A'.repeat(43)}` }],
    ['an unknown token', { authorization: `Bearer ql_at_${'A'.repeat(43)}` }],
    ['a malformed token', { authorization: 'Bearer not-a-token' }],
  ])('refuses %s with 401 and WWW-Authenticate: Bearer', async (_name, headers) => {
    const response = await whoami(headers);

    expect(response.statusCode).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');
    expect(response.json()).toMatchObject({ type: 'urn:questline:problem:unauthorized', status: 401 });
  });

  it('accepts the scheme in any letter case (RFC 9110)', async () => {
    const pair = await login(await ctx.account());

    expect((await whoami({ authorization: `bearer ${pair.access_token}` })).statusCode).toBe(200);
  });

  it('refuses a refresh token used as an access token', async () => {
    const pair = await login(await ctx.account());

    expect((await whoami(bearer(pair.refresh_token))).statusCode).toBe(401);
  });

  it('accepts an access token for 15 minutes, not a second longer [R-AUTH-10]', async () => {
    const pair = await login(await ctx.account());

    ctx.clock.advance({ minutes: 14, seconds: 59 });
    expect((await whoami(bearer(pair.access_token))).statusCode).toBe(200);
    ctx.clock.advance({ seconds: 1 });
    expect((await whoami(bearer(pair.access_token))).statusCode).toBe(401);
  });

  it('keeps an access token valid after a refresh until it expires', async () => {
    const pair = await login(await ctx.account());
    const next = (await ctx.post('/v1/auth/refresh', { refresh_token: pair.refresh_token })).json<TokenPair>();

    expect((await whoami(bearer(pair.access_token))).statusCode).toBe(200);
    expect((await whoami(bearer(next.access_token))).statusCode).toBe(200);
  });

  it('refuses the access token of a revoked or expired session even if its tokens were not deleted', async () => {
    const revoked = await login(await ctx.account());
    const expired = await login(await ctx.account());
    ctx.clock.advance({ minutes: 1 });
    await ctx.admin.sql`update sessions set revoked_at = ${ctx.clock.now()}, revoked_reason = 'logout'
      where id = ${revoked.session_id}`;
    await ctx.admin.sql`update sessions set absolute_expires_at = ${ctx.clock.now()} where id = ${expired.session_id}`;

    expect((await whoami(bearer(revoked.access_token))).statusCode).toBe(401);
    expect((await whoami(bearer(expired.access_token))).statusCode).toBe(401);
  });

  it('logs out the current session only: revoked, tokens deleted, audited [R-AUTH-05]', async () => {
    const account = await ctx.account();
    const current = await login(account);
    const other = await login(account);

    const response = await logout(current.access_token);

    expect(response.statusCode).toBe(204);
    expect(await sessionRow(current.session_id)).toMatchObject({ revoked_reason: 'logout' });
    expect(await tokenCount(current.session_id)).toBe(0);
    expect((await whoami(bearer(current.access_token))).statusCode).toBe(401);
    expect((await ctx.post('/v1/auth/refresh', { refresh_token: current.refresh_token })).statusCode).toBe(401);
    expect((await whoami(bearer(other.access_token))).statusCode).toBe(200);
    const events = await ctx.worker.sql`
      select session_id, metadata from audit_events where user_id = ${account.userId} and event_type = 'logout'`;
    expect(events.map((row) => ({ ...row }))).toEqual([{ session_id: current.session_id, metadata: {} }]);
  });

  it('logs out every session of the user and no one else [R-AUTH-05]', async () => {
    const account = await ctx.account();
    const sessions = [await login(account), await login(account), await login(account)];
    const stranger = await login(await ctx.account());

    const response = await logout(sessions[0]?.access_token ?? '', '/v1/auth/logout-all');

    expect(response.statusCode).toBe(204);
    for (const pair of sessions) {
      expect(await sessionRow(pair.session_id)).toMatchObject({ revoked_reason: 'logout_all' });
      expect(await tokenCount(pair.session_id)).toBe(0);
      expect((await whoami(bearer(pair.access_token))).statusCode).toBe(401);
    }
    expect((await whoami(bearer(stranger.access_token))).statusCode).toBe(200);
    const events = await ctx.worker.sql`
      select session_id, metadata from audit_events where user_id = ${account.userId} and event_type = 'logout'`;
    expect(events.map((row) => ({ ...row }))).toEqual([
      { session_id: sessions[0]?.session_id, metadata: { scope: 'all' } },
    ]);
  });

  it('answers logout without a valid token with the documented 401', async () => {
    const response = await contractInject(ctx.app, { method: 'POST', url: '/v1/auth/logout' });

    expect(response.statusCode).toBe(401);
  });
});
