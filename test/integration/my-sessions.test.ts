import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAccountsApp, type AccountsApp, type TestAccount } from '../helpers/accounts-app.ts';
import { contractInject } from '../helpers/contract.ts';
import { LogCapture } from '../helpers/log-capture.ts';

interface TokenPair {
  access_token: string;
  refresh_token: string;
  session_id: string;
}

interface SessionView {
  id: string;
  client: string;
  device_label: string | null;
  created_at: string;
  last_used_at: string;
  current: boolean;
}

describe('my sessions and re-authentication [R-AUTH-05, R-AUTH-06, R-AUTHZ-02, Q-09]', () => {
  let ctx: AccountsApp;
  const logs = new LogCapture();

  const login = async (account: TestAccount, extra: Record<string, unknown> = {}): Promise<TokenPair> => {
    const response = await ctx.post('/v1/auth/login', {
      email: account.email,
      password: account.password,
      client: 'ios',
      ...extra,
    });
    expect(response.statusCode).toBe(200);
    return response.json();
  };
  const bearer = (pair: TokenPair) => ({ authorization: `Bearer ${pair.access_token}` });
  const list = async (pair: TokenPair) => {
    const response = await contractInject(ctx.app, { method: 'GET', url: '/v1/me/sessions', headers: bearer(pair) });
    expect(response.statusCode).toBe(200);
    return response.json<{ items: SessionView[] }>().items;
  };
  const revoke = (pair: TokenPair, sessionId: string) =>
    contractInject(ctx.app, { method: 'DELETE', url: `/v1/me/sessions/${sessionId}`, headers: bearer(pair) });
  const reauth = (pair: TokenPair, password: string) => ctx.post('/v1/auth/reauth', { password }, bearer(pair));
  const whoami = (pair: TokenPair) =>
    ctx.app.inject({ method: 'GET', url: '/__test/v1/whoami', headers: bearer(pair) });
  const sessionRow = async (sessionId: string) =>
    (await ctx.worker.sql<Record<string, unknown>[]>`select * from sessions where id = ${sessionId}`)[0];
  const events = async (userId: string, type: string) =>
    (
      await ctx.worker.sql<Record<string, unknown>[]>`
        select outcome, session_id, metadata from audit_events where user_id = ${userId} and event_type = ${type}`
    ).map((row) => ({ ...row }));

  beforeAll(async () => {
    ctx = await startAccountsApp({ logCapture: logs });
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('GET /v1/me/sessions', () => {
    it('lists only my active sessions, newest first, with decrypted labels and the current one marked', async () => {
      const account = await ctx.account();
      const phone = await login(account, { device_label: 'Anna’s iPhone' });
      ctx.clock.advance({ minutes: 1 });
      const tablet = await login(account, { client: 'android' });
      ctx.clock.advance({ minutes: 1 });
      const revoked = await login(account);
      ctx.clock.advance({ minutes: 1 });
      const refreshExpired = await login(account);
      await ctx.admin.sql`update sessions set revoked_at = ${ctx.clock.now()}, revoked_reason = 'logout'
        where id = ${revoked.session_id}`;
      await ctx.admin.sql`update session_tokens set refresh_expires_at = access_expires_at
        where session_id = ${refreshExpired.session_id}`;
      await login(await ctx.account());
      ctx.clock.advance({ minutes: 20 });
      const current = (await ctx.post('/v1/auth/refresh', { refresh_token: tablet.refresh_token })).json<TokenPair>();

      const items = await list(current);

      expect(items).toEqual([
        {
          id: tablet.session_id,
          client: 'android',
          device_label: null,
          created_at: '2026-10-29T12:01:00.000Z',
          last_used_at: '2026-10-29T12:23:00.000Z',
          current: true,
        },
        {
          id: phone.session_id,
          client: 'ios',
          device_label: 'Anna’s iPhone',
          created_at: '2026-10-29T12:00:00.000Z',
          last_used_at: '2026-10-29T12:00:00.000Z',
          current: false,
        },
      ]);
    });
  });

  describe('DELETE /v1/me/sessions/{sessionId}', () => {
    it('revokes another of my sessions: its tokens stop working, mine keep working, the revocation is audited', async () => {
      const account = await ctx.account();
      const mine = await login(account);
      const other = await login(account);

      const response = await revoke(mine, other.session_id);

      expect(response.statusCode).toBe(204);
      expect(await sessionRow(other.session_id)).toMatchObject({ revoked_reason: 'user_revoked' });
      const [tokens] = await ctx.worker.sql<{ count: string }[]>`
        select count(*) from session_tokens where session_id = ${other.session_id}`;
      expect(tokens?.count).toBe('0');
      expect((await whoami(other)).statusCode).toBe(401);
      expect((await ctx.post('/v1/auth/refresh', { refresh_token: other.refresh_token })).statusCode).toBe(401);
      expect((await whoami(mine)).statusCode).toBe(200);
      expect(await events(account.userId, 'session_revoked')).toEqual([
        { outcome: 'success', session_id: other.session_id, metadata: { reason: 'user_revoked' } },
      ]);
    });

    it('revokes the current session too, like a logout', async () => {
      const pair = await login(await ctx.account());

      expect((await revoke(pair, pair.session_id)).statusCode).toBe(204);
      expect((await whoami(pair)).statusCode).toBe(401);
    });

    it('answers 404 for another user’s session and leaves it alone [R-AUTHZ-02]', async () => {
      const mine = await login(await ctx.account());
      const theirs = await login(await ctx.account());

      const response = await revoke(mine, theirs.session_id);

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ type: 'urn:questline:problem:not-found' });
      expect(await sessionRow(theirs.session_id)).toMatchObject({ revoked_at: null });
      expect((await whoami(theirs)).statusCode).toBe(200);
    });

    it.each([
      ['an unknown id', () => randomUUID()],
      ['a malformed id (no 400 in the contract)', () => 'not-a-uuid'],
      ['an upper-case id', () => randomUUID().toUpperCase()],
    ])('answers 404 for %s', async (_name, id) => {
      const pair = await login(await ctx.account());

      expect((await revoke(pair, id())).statusCode).toBe(404);
    });

    it('answers 404 for a session that is already revoked', async () => {
      const account = await ctx.account();
      const mine = await login(account);
      const other = await login(account);
      await revoke(mine, other.session_id);

      expect((await revoke(mine, other.session_id)).statusCode).toBe(404);
    });
  });

  describe('POST /v1/auth/reauth', () => {
    it('marks the session as recently authenticated with the correct password and audits it', async () => {
      const account = await ctx.account();
      const pair = await login(account);
      ctx.clock.advance({ minutes: 12 });
      const before = ctx.verifyCount();

      const response = await reauth(pair, account.password);

      expect(response.statusCode).toBe(204);
      expect(ctx.verifyCount() - before).toBe(1);
      expect(await sessionRow(pair.session_id)).toMatchObject({ last_reauth_at: ctx.clock.now() });
      expect((await whoami(pair)).json()).toMatchObject({ lastReauthAt: ctx.clock.now().toISOString() });
      expect(await events(account.userId, 'reauth_succeeded')).toEqual([
        { outcome: 'success', session_id: pair.session_id, metadata: {} },
      ]);
    });

    it('refuses a wrong password with 401 invalid-credentials, changes nothing and audits the failure', async () => {
      const account = await ctx.account();
      const pair = await login(account);
      const loggedInAt = (await sessionRow(pair.session_id))?.['last_reauth_at'];
      ctx.clock.advance({ minutes: 12 });

      const response = await reauth(pair, 'not the right passphrase');

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ type: 'urn:questline:problem:invalid-credentials' });
      expect(await sessionRow(pair.session_id)).toMatchObject({ last_reauth_at: loggedInAt });
      expect(await events(account.userId, 'reauth_failed')).toMatchObject([{ outcome: 'failure' }]);
    });

    it('refuses a password shorter than 12 characters with 400', async () => {
      const pair = await login(await ctx.account());

      expect((await reauth(pair, 'short')).statusCode).toBe(400);
    });
  });

  it('never writes a device label or a password to the log [R-LOG-02]', () => {
    for (const secret of ['iPhone', 'purple elephants', 'not the right passphrase']) {
      expect(logs.text).not.toContain(secret);
    }
  });
});
