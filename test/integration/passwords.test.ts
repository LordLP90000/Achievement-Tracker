import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAccountsApp, type AccountsApp, type TestAccount } from '../helpers/accounts-app.ts';
import { LogCapture } from '../helpers/log-capture.ts';

interface TokenPair {
  access_token: string;
  refresh_token: string;
  session_id: string;
}

const ACCEPTED = { message: 'If the request can be fulfilled, an email has been sent.' };
const NEW_PASSWORD = 'seven silver swans swimming';
/** In the offline breach list (ADR-0012). */
const BREACHED = 'password1234';
const MINUTE = 60_000;

describe('password change, forgot and reset [R-AUTH-02, R-AUTH-03, R-AUTH-05, R-AUTH-06, R-AUTH-07]', () => {
  let ctx: AccountsApp;
  const logs = new LogCapture();

  const login = (email: string, password: string) => ctx.post('/v1/auth/login', { email, password, client: 'ios' });
  const session = async (account: TestAccount): Promise<TokenPair> => {
    const response = await login(account.email, account.password);
    expect(response.statusCode).toBe(200);
    return response.json();
  };
  const bearer = (pair: TokenPair) => ({ authorization: `Bearer ${pair.access_token}` });
  const change = (pair: TokenPair, current: string, next: string) =>
    ctx.post('/v1/me/password', { current_password: current, new_password: next }, bearer(pair));
  const forgot = (email: string) => ctx.post('/v1/auth/password/forgot', { email });
  const reset = (token: string, password: string) =>
    ctx.post('/v1/auth/password/reset', { token, new_password: password });
  const whoami = (pair: TokenPair) =>
    ctx.app.inject({ method: 'GET', url: '/__test/v1/whoami', headers: bearer(pair) });
  const userRow = async (userId: string) =>
    (await ctx.worker.sql<Record<string, unknown>[]>`select * from users where id = ${userId}`)[0];
  const sessionRow = async (sessionId: string) =>
    (await ctx.worker.sql<Record<string, unknown>[]>`select * from sessions where id = ${sessionId}`)[0];
  const templatesTo = async (email: string) =>
    (await ctx.emails()).filter((queued) => queued.payload.to === email).map((queued) => queued.template);
  const resetToken = async (email: string) => {
    const queued = (await ctx.emails()).findLast(
      (entry) => entry.payload.to === email && entry.template === 'password_reset',
    );
    if (queued?.payload.token === undefined) throw new Error(`no reset email for ${email}`);
    return queued.payload.token;
  };
  const events = async (userId: string, type: string) =>
    (
      await ctx.worker.sql<Record<string, unknown>[]>`
        select outcome, session_id from audit_events where user_id = ${userId} and event_type = ${type}
        order by created_at`
    ).map((row) => ({ ...row }));

  beforeAll(async () => {
    ctx = await startAccountsApp({ logCapture: logs });
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('POST /v1/me/password', () => {
    it('changes the password, keeps this session, ends every other one, audits it and notifies the owner', async () => {
      const account = await ctx.account();
      const other = await session(account);
      const current = await session(account);
      ctx.clock.advance({ minutes: 5 });

      const response = await change(current, account.password, NEW_PASSWORD);

      expect(response.statusCode).toBe(204);
      expect((await login(account.email, account.password)).statusCode).toBe(401);
      expect((await login(account.email, NEW_PASSWORD)).statusCode).toBe(200);
      expect(await userRow(account.userId)).toMatchObject({ password_changed_at: ctx.clock.now() });
      expect((await whoami(current)).statusCode).toBe(200);
      expect(await sessionRow(other.session_id)).toMatchObject({ revoked_reason: 'password_changed' });
      expect((await whoami(other)).statusCode).toBe(401);
      expect((await ctx.post('/v1/auth/refresh', { refresh_token: other.refresh_token })).statusCode).toBe(401);
      expect(await events(account.userId, 'password_changed')).toEqual([
        { outcome: 'success', session_id: current.session_id },
      ]);
      expect(await templatesTo(account.email)).toEqual(['verify_email', 'password_changed_notice']);
    });

    it('requires the password to have been entered within the last 10 minutes [R-AUTH-06]', async () => {
      const account = await ctx.account();
      const pair = await session(account);
      ctx.clock.advance({ minutes: 10 });
      const fresh = (await ctx.post('/v1/auth/refresh', { refresh_token: pair.refresh_token })).json<TokenPair>();

      const response = await change(fresh, account.password, NEW_PASSWORD);

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ type: 'urn:questline:problem:reauthentication-required' });
      expect((await login(account.email, account.password)).statusCode).toBe(200);
      expect(await templatesTo(account.email)).toEqual(['verify_email']);
    });

    it('refuses a wrong current password with 401, changes nothing and audits the failure', async () => {
      const account = await ctx.account();
      const other = await session(account);
      const current = await session(account);

      const response = await change(current, 'not the right passphrase', NEW_PASSWORD);

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ type: 'urn:questline:problem:invalid-credentials' });
      expect((await login(account.email, account.password)).statusCode).toBe(200);
      expect((await whoami(other)).statusCode).toBe(200);
      expect(await events(account.userId, 'password_changed')).toEqual([
        { outcome: 'failure', session_id: current.session_id },
      ]);
    });

    it('refuses a breached new password with 422 and changes nothing', async () => {
      const account = await ctx.account();
      const pair = await session(account);

      const response = await change(pair, account.password, BREACHED);

      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({ type: 'urn:questline:problem:weak-password' });
      expect((await login(account.email, account.password)).statusCode).toBe(200);
    });

    it('refuses a new password shorter than 12 characters with 400', async () => {
      const account = await ctx.account();
      const pair = await session(account);

      const response = await change(pair, account.password, 'too short');

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ errors: [{ pointer: '/new_password' }] });
    });

    it('lets a password change that happens while the current password is being verified win', async () => {
      const account = await ctx.account();
      const pair = await session(account);
      ctx.afterPasswordVerified = async () => {
        await ctx.admin.sql`update users set password_hash = 'changed-meanwhile' where id = ${account.userId}`;
      };
      try {
        expect((await change(pair, account.password, NEW_PASSWORD)).statusCode).toBe(401);
      } finally {
        ctx.afterPasswordVerified = undefined;
      }
      expect(await userRow(account.userId)).toMatchObject({ password_hash: 'changed-meanwhile' });
    });
  });

  describe('POST /v1/auth/password/forgot', () => {
    it('emails a 30-minute single-use reset token, stored only as a hash, and audits the request', async () => {
      const account = await ctx.account();

      const response = await forgot(account.email.toUpperCase());

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual(ACCEPTED);
      const token = await resetToken(account.email);
      expect(token).toMatch(/^ql_pt_[\w-]{43}$/);
      const rows = await ctx.worker.sql<{ token_hash: Buffer; expires_at: Date }[]>`
        select token_hash, expires_at from one_time_tokens
        where user_id = ${account.userId} and purpose = 'reset_password'`;
      expect(rows).toEqual([
        {
          token_hash: createHash('sha256').update(token).digest(),
          expires_at: new Date(ctx.clock.now().getTime() + 30 * MINUTE),
        },
      ]);
      expect(await events(account.userId, 'password_reset_requested')).toMatchObject([{ outcome: 'success' }]);
    });

    it('also emails an unverified account, but nothing to an unknown address or an account pending deletion', async () => {
      const unverified = await ctx.account({ verified: false });
      const deactivated = await ctx.account();
      await ctx.admin.sql`update users set deactivated_at = ${ctx.clock.now()} where id = ${deactivated.userId}`;
      const before = (await ctx.emails()).length;

      for (const email of [unverified.email, deactivated.email, 'nobody@example.test']) {
        const response = await forgot(email);
        expect(response.statusCode).toBe(202);
        expect(response.json()).toEqual(ACCEPTED);
      }

      expect((await ctx.emails()).length).toBe(before + 1);
      expect(await templatesTo(unverified.email)).toEqual(['verify_email', 'password_reset']);
    });
  });

  describe('POST /v1/auth/password/reset', () => {
    it('sets the new password, ends every session, audits it and notifies the owner [R-AUTH-05]', async () => {
      const account = await ctx.account();
      const pairs = [await session(account), await session(account)];
      await forgot(account.email);

      const response = await reset(await resetToken(account.email), NEW_PASSWORD);

      expect(response.statusCode).toBe(204);
      expect((await login(account.email, account.password)).statusCode).toBe(401);
      expect((await login(account.email, NEW_PASSWORD)).statusCode).toBe(200);
      for (const pair of pairs) {
        expect(await sessionRow(pair.session_id)).toMatchObject({ revoked_reason: 'password_reset' });
        expect((await whoami(pair)).statusCode).toBe(401);
      }
      expect(await events(account.userId, 'password_reset_completed')).toMatchObject([{ outcome: 'success' }]);
      expect(await templatesTo(account.email)).toEqual(['verify_email', 'password_reset', 'password_changed_notice']);
    });

    it('accepts a reset token once [R-AUTH-03]', async () => {
      const account = await ctx.account();
      await forgot(account.email);
      const token = await resetToken(account.email);
      await reset(token, NEW_PASSWORD);

      const replay = await reset(token, 'another fine passphrase');

      expect(replay.statusCode).toBe(401);
      expect(replay.json()).toMatchObject({ type: 'urn:questline:problem:invalid-token' });
      expect((await login(account.email, NEW_PASSWORD)).statusCode).toBe(200);
    });

    it('refuses a token older than 30 minutes, a superseded token and a token of another kind, without hashing [D-01]', async () => {
      const account = await ctx.account();
      await forgot(account.email);
      const superseded = await resetToken(account.email);
      await forgot(account.email);
      const latest = await resetToken(account.email);
      const hashes = ctx.hashCount();

      expect((await reset(superseded, NEW_PASSWORD)).statusCode).toBe(401);
      expect((await reset(latest.replace('ql_pt_', 'ql_vt_'), NEW_PASSWORD)).statusCode).toBe(401);
      ctx.clock.advance({ minutes: 30 });
      expect((await reset(latest, NEW_PASSWORD)).statusCode).toBe(401);
      expect(ctx.hashCount()).toBe(hashes);
      expect((await login(account.email, account.password)).statusCode).toBe(200);
    });

    it('refuses a breached new password with 422 without using up the token', async () => {
      const account = await ctx.account();
      await forgot(account.email);
      const token = await resetToken(account.email);

      const weak = await reset(token, BREACHED);

      expect(weak.statusCode).toBe(422);
      expect((await reset(token, NEW_PASSWORD)).statusCode).toBe(204);
    });

    it('verifies the address of an unverified account: the reset link reached it [R-AUTH-09]', async () => {
      const account = await ctx.account({ verified: false });
      await forgot(account.email);

      expect((await reset(await resetToken(account.email), NEW_PASSWORD)).statusCode).toBe(204);

      expect(await userRow(account.userId)).toMatchObject({ email_verified_at: ctx.clock.now() });
      expect(await events(account.userId, 'email_verified')).toMatchObject([{ outcome: 'success' }]);
      expect((await login(account.email, NEW_PASSWORD)).statusCode).toBe(200);
    });

    it('refuses a malformed token with 400', async () => {
      expect((await reset('not-a-token', NEW_PASSWORD)).statusCode).toBe(400);
    });
  });

  it('never writes a password or a reset token to the log [R-LOG-02]', async () => {
    const tokens = (await ctx.emails()).map((queued) => queued.payload.token).filter((token) => token !== undefined);

    expect(tokens.length).toBeGreaterThan(5);
    for (const secret of [NEW_PASSWORD, BREACHED, 'purple elephants', ...tokens]) {
      expect(logs.text).not.toContain(secret);
    }
  });
});
