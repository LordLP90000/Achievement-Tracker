import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAccountsApp, type AccountsApp, type TestAccount } from '../helpers/accounts-app.ts';
import { LogCapture } from '../helpers/log-capture.ts';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const sha256 = (value: string) => createHash('sha256').update(value).digest();

interface TokenPair {
  access_token: string;
  access_expires_in: number;
  refresh_token: string;
  refresh_expires_in: number;
  session_id: string;
}

describe('refresh token rotation [R-AUTH-04, R-AUTH-10]', () => {
  let ctx: AccountsApp;
  const logs = new LogCapture();
  const issued: string[] = [];

  const login = async (account: TestAccount): Promise<TokenPair> => {
    const response = await ctx.post('/v1/auth/login', {
      email: account.email,
      password: account.password,
      client: 'ios',
    });
    expect(response.statusCode).toBe(200);
    const pair = response.json<TokenPair>();
    issued.push(pair.access_token, pair.refresh_token);
    return pair;
  };
  const refresh = async (refreshToken: string) => {
    const response = await ctx.post('/v1/auth/refresh', { refresh_token: refreshToken });
    if (response.statusCode === 200) {
      const pair = response.json<TokenPair>();
      issued.push(pair.access_token, pair.refresh_token);
    }
    return response;
  };
  const sessionRow = async (sessionId: string) =>
    (await ctx.worker.sql<Record<string, unknown>[]>`select * from sessions where id = ${sessionId}`)[0];
  const generations = async (sessionId: string) =>
    (
      await ctx.worker.sql<Record<string, unknown>[]>`
        select generation, access_token_hash, refresh_token_hash, access_expires_at, refresh_expires_at, rotated_at
        from session_tokens where session_id = ${sessionId} order by generation`
    ).map((row) => ({ ...row }));
  /** API connections of this test database that are blocked on a row lock. */
  const waitingForLocks = async () => {
    const [row] = await ctx.admin.sql<{ count: string }[]>`
      select count(*) from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and usename = 'questline_app'`;
    return Number(row?.count);
  };

  beforeAll(async () => {
    ctx = await startAccountsApp({ logCapture: logs });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('rotates: a new token pair, the used generation marked, the session touched and the window slid', async () => {
    const first = await login(await ctx.account());
    ctx.clock.advance({ days: 3 });
    const now = ctx.clock.now();

    const response = await refresh(first.refresh_token);

    expect(response.statusCode).toBe(200);
    const second = response.json<TokenPair>();
    expect(second).toMatchObject({
      session_id: first.session_id,
      access_expires_in: 900,
      refresh_expires_in: 30 * 24 * 3600,
    });
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(await generations(first.session_id)).toEqual([
      expect.objectContaining({ generation: 1, refresh_token_hash: sha256(first.refresh_token), rotated_at: now }),
      expect.objectContaining({
        generation: 2,
        access_token_hash: sha256(second.access_token),
        access_expires_at: new Date(now.getTime() + 15 * MINUTE),
        refresh_token_hash: sha256(second.refresh_token),
        refresh_expires_at: new Date(now.getTime() + 30 * DAY),
        rotated_at: null,
      }),
    ]);
    expect(await sessionRow(first.session_id)).toMatchObject({ last_used_at: now, revoked_at: null });
  });

  it('revokes the whole session when a rotated refresh token comes back, and audits it', async () => {
    const account = await ctx.account();
    const first = await login(account);
    const second = (await refresh(first.refresh_token)).json<TokenPair>();

    const reuse = await refresh(first.refresh_token);

    expect(reuse.statusCode).toBe(401);
    expect(reuse.json()).toMatchObject({ type: 'urn:questline:problem:invalid-token', status: 401 });
    expect(await sessionRow(first.session_id)).toMatchObject({ revoked_reason: 'refresh_reuse' });
    expect(await generations(first.session_id)).toEqual([]);
    expect((await refresh(second.refresh_token)).statusCode).toBe(401);
    const events = await ctx.worker.sql`
      select event_type, outcome, session_id from audit_events
      where user_id = ${account.userId} and event_type = 'refresh_reuse_detected'`;
    expect(events.map((row) => ({ ...row }))).toEqual([
      { event_type: 'refresh_reuse_detected', outcome: 'failure', session_id: first.session_id },
    ]);
  });

  it('treats two concurrent uses of one refresh token as reuse: one pair is issued, then the session ends', async () => {
    const first = await login(await ctx.account());
    // Hold the token row until both requests wait for it, so they truly race (deterministic, no sleeps).
    const { promise: released, resolve: release } = Promise.withResolvers<undefined>();
    const { promise: isLocked, resolve: locked } = Promise.withResolvers<undefined>();
    const holder = ctx.admin.sql.begin(async (tx) => {
      await tx`select id from session_tokens where session_id = ${first.session_id} for update`;
      locked(undefined);
      await released;
    });
    await isLocked;

    const racing = Promise.all([refresh(first.refresh_token), refresh(first.refresh_token)]);
    await expect.poll(waitingForLocks, { timeout: 5000, interval: 10 }).toBe(2);
    release(undefined);
    await holder;
    const responses = await racing;

    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 401]);
    expect(await sessionRow(first.session_id)).toMatchObject({ revoked_reason: 'refresh_reuse' });
  });

  it('refuses a refresh token unused for 30 days, but every use slides the window [R-AUTH-10]', async () => {
    const account = await ctx.account();
    let pair = await login(account);
    for (let use = 0; use < 3; use += 1) {
      ctx.clock.advance({ days: 29 });
      const response = await refresh(pair.refresh_token);
      expect(response.statusCode).toBe(200);
      pair = response.json<TokenPair>();
    }

    ctx.clock.advance({ days: 30, seconds: 1 });

    expect((await refresh(pair.refresh_token)).statusCode).toBe(401);
  });

  it('expires a refresh token exactly 30 days after it was issued', async () => {
    const pair = await login(await ctx.account());
    ctx.clock.advance({ days: 30 });

    expect((await refresh(pair.refresh_token)).statusCode).toBe(401);
  });

  it('refuses a session past its absolute expiry even if its refresh token is still valid (defence in depth)', async () => {
    const pair = await login(await ctx.account());
    ctx.clock.advance({ minutes: 1 });
    await ctx.admin.sql`update sessions set absolute_expires_at = ${ctx.clock.now()} where id = ${pair.session_id}`;

    expect((await refresh(pair.refresh_token)).statusCode).toBe(401);
  });

  it('ends a session 180 days after login even when it is used every day, capping the last tokens [R-AUTH-10]', async () => {
    let pair = await login(await ctx.account());
    const absolute = ctx.clock.now().getTime() + 180 * DAY;
    for (let day = 0; day < 6; day += 1) {
      ctx.clock.advance({ days: 29 });
      pair = (await refresh(pair.refresh_token)).json<TokenPair>();
    }
    ctx.clock.set(new Date(absolute - 10 * MINUTE).toISOString());

    const late = await refresh(pair.refresh_token);

    expect(late.statusCode).toBe(200);
    pair = late.json<TokenPair>();
    expect(pair).toMatchObject({ access_expires_in: 600, refresh_expires_in: 600 });
    ctx.clock.set(new Date(absolute).toISOString());
    expect((await refresh(pair.refresh_token)).statusCode).toBe(401);
  });

  it('refuses the refresh token of a revoked session even if its tokens were not deleted', async () => {
    const pair = await login(await ctx.account());
    await ctx.admin.sql`update sessions set revoked_at = ${ctx.clock.now()}, revoked_reason = 'logout'
      where id = ${pair.session_id}`;

    expect((await refresh(pair.refresh_token)).statusCode).toBe(401);
  });

  it('refuses an access token, an unknown token and a malformed token', async () => {
    const pair = await login(await ctx.account());

    expect((await refresh(pair.access_token)).statusCode).toBe(401);
    expect((await refresh(`ql_rt_${'A'.repeat(43)}`)).statusCode).toBe(401);
    expect((await refresh('ql_rt_short')).statusCode).toBe(400);
    expect((await sessionRow(pair.session_id))?.['revoked_at']).toBeNull();
  });

  it('never writes a token to the log [R-LOG-02]', () => {
    expect(issued.length).toBeGreaterThan(20);
    for (const token of issued) expect(logs.text).not.toContain(token);
  });
});
