import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAccountsApp, type AccountsApp, type TestAccount } from '../helpers/accounts-app.ts';
import { LogCapture } from '../helpers/log-capture.ts';

interface TokenPair {
  access_token: string;
  refresh_token: string;
}

const ACCEPTED = { message: 'If the request can be fulfilled, an email has been sent.' };

describe('email change [A-12, R-AUTH-06, R-AUTH-07, S-08, I-06]', () => {
  let ctx: AccountsApp;
  const logs = new LogCapture();
  const newAddress = () => `new-${randomUUID().slice(0, 8)}@example.test`;
  const session = async (account: TestAccount): Promise<TokenPair> =>
    (await ctx.post('/v1/auth/login', { email: account.email, password: account.password, client: 'ios' })).json();
  const bearer = (pair: TokenPair) => ({ authorization: `Bearer ${pair.access_token}` });
  const request = (pair: TokenPair, email: string) =>
    ctx.post('/v1/me/email-change', { new_email: email }, bearer(pair));
  const confirm = (token: string) => ctx.post('/v1/me/email-change/confirm', { token });
  const emailsTo = async (email: string) => (await ctx.emails()).filter((queued) => queued.payload.to === email);
  const changeToken = async (email: string) => {
    const queued = (await emailsTo(email)).findLast((entry) => entry.template === 'email_change_verify');
    if (queued?.payload.token === undefined) throw new Error(`no email-change link sent to ${email}`);
    return queued.payload.token;
  };
  const userRow = async (userId: string) =>
    (await ctx.worker.sql<Record<string, unknown>[]>`select * from users where id = ${userId}`)[0];
  const login = (email: string, password: string) => ctx.post('/v1/auth/login', { email, password, client: 'android' });
  const events = async (userId: string, type: string) =>
    (
      await ctx.worker.sql<Record<string, unknown>[]>`
        select outcome from audit_events where user_id = ${userId} and event_type = ${type}`
    ).map((row) => ({ ...row }));

  beforeAll(async () => {
    ctx = await startAccountsApp({ logCapture: logs });
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('POST /v1/me/email-change', () => {
    it('sends a 30-minute link to the new address and keeps that address only encrypted until it is confirmed', async () => {
      const account = await ctx.account();
      const target = newAddress();

      const response = await request(await session(account), target);

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual(ACCEPTED);
      expect(await changeToken(target)).toMatch(/^ql_vt_[\w-]{43}$/);
      const [token] = await ctx.worker.sql<Record<string, unknown>[]>`
        select * from one_time_tokens where user_id = ${account.userId} and purpose = 'change_email'`;
      expect(token?.['new_email_blind_index']).toEqual(ctx.blindIndex(target));
      expect((token?.['new_email_enc'] as Buffer).includes(Buffer.from(target))).toBe(false);
      expect(token?.['expires_at']).toEqual(new Date(ctx.clock.now().getTime() + 30 * 60_000));
      expect(await userRow(account.userId)).toMatchObject({ email_blind_index: ctx.blindIndex(account.email) });
      expect(await events(account.userId, 'email_change_requested')).toEqual([{ outcome: 'success' }]);
    });

    it('requires the password to have been entered within the last 10 minutes [R-AUTH-06]', async () => {
      const account = await ctx.account();
      const pair = await session(account);
      ctx.clock.advance({ minutes: 10 });
      const fresh = (await ctx.post('/v1/auth/refresh', { refresh_token: pair.refresh_token })).json<TokenPair>();
      const target = newAddress();

      const response = await request(fresh, target);

      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ type: 'urn:questline:problem:reauthentication-required' });
      expect(await emailsTo(target)).toEqual([]);
    });

    it('tells the owner of an address that is taken, not the requester, and answers alike [I-06]', async () => {
      const requester = await ctx.account();
      const owner = await ctx.account();
      const pair = await session(requester);
      const free = await request(pair, newAddress());

      const taken = await request(pair, owner.email);

      expect(taken.statusCode).toBe(free.statusCode);
      expect(taken.json()).toEqual(free.json());
      expect((await emailsTo(owner.email)).map((queued) => queued.template)).toEqual([
        'verify_email',
        'registration_notice',
      ]);
    });

    it('sends nothing for the own address or an address of an account pending deletion [A-22]', async () => {
      const account = await ctx.account();
      const pending = await ctx.account();
      await ctx.admin.sql`update users set deactivated_at = ${ctx.clock.now()} where id = ${pending.userId}`;
      const pair = await session(account);
      const before = (await ctx.emails()).length;

      expect((await request(pair, account.email.toUpperCase())).statusCode).toBe(202);
      expect((await request(pair, pending.email)).statusCode).toBe(202);

      expect((await ctx.emails()).length).toBe(before);
    });

    it('refuses an invalid address with 400', async () => {
      const pair = await session(await ctx.account());

      expect((await request(pair, 'not-an-address')).statusCode).toBe(400);
    });
  });

  describe('POST /v1/me/email-change/confirm', () => {
    it('switches the account to the verified new address, notifies the old one and audits it', async () => {
      const account = await ctx.account();
      const target = newAddress();
      await request(await session(account), target);
      ctx.clock.advance({ minutes: 5 });

      const response = await confirm(await changeToken(target));

      expect(response.statusCode).toBe(204);
      const user = await userRow(account.userId);
      expect(user).toMatchObject({
        email_blind_index: ctx.blindIndex(target),
        email_verified_at: ctx.clock.now(),
        version: 3,
      });
      expect(await ctx.decrypt(account.userId, account.userId, 'email_enc', user?.['email_enc'] as Buffer)).toBe(
        target,
      );
      expect((await emailsTo(account.email)).map((queued) => queued.template)).toEqual([
        'verify_email',
        'email_change_notice',
      ]);
      expect(await events(account.userId, 'email_changed')).toEqual([{ outcome: 'success' }]);
      expect((await login(target, account.password)).statusCode).toBe(200);
      expect((await login(account.email, account.password)).statusCode).toBe(401);
    });

    it('accepts a link once, within 30 minutes, and only the newest one [R-AUTH-03]', async () => {
      const account = await ctx.account();
      const pair = await session(account);
      const first = newAddress();
      const second = newAddress();
      await request(pair, first);
      await request(pair, second);
      const superseded = await changeToken(first);
      const latest = await changeToken(second);

      expect((await confirm(superseded)).statusCode).toBe(401);
      ctx.clock.advance({ minutes: 30 });
      expect((await confirm(latest)).statusCode).toBe(401);
      expect(await userRow(account.userId)).toMatchObject({ email_blind_index: ctx.blindIndex(account.email) });
    });

    it('refuses a replayed link', async () => {
      const account = await ctx.account();
      const target = newAddress();
      await request(await session(account), target);
      const token = await changeToken(target);
      await confirm(token);

      const replay = await confirm(token);

      expect(replay.statusCode).toBe(401);
      expect(replay.json()).toMatchObject({ type: 'urn:questline:problem:invalid-token' });
    });

    it('refuses a registration link: the purposes are kept apart', async () => {
      const account = await ctx.account({ verified: false });
      const token = (await emailsTo(account.email)).find((queued) => queued.template === 'verify_email')?.payload.token;

      expect((await confirm(token ?? '')).statusCode).toBe(401);
    });

    it('answers 409 when the new address was registered meanwhile, and changes nothing', async () => {
      const account = await ctx.account();
      const target = newAddress();
      await request(await session(account), target);
      await ctx.post('/v1/auth/register', {
        email: target,
        password: 'a different strong passphrase',
        privacy_policy_version: '2026-10-01',
        age_confirmed: true,
      });

      const response = await confirm(await changeToken(target));

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ type: 'urn:questline:problem:email-taken', status: 409 });
      expect(await userRow(account.userId)).toMatchObject({ email_blind_index: ctx.blindIndex(account.email) });
    });

    it('voids pending reset and verification links that went to the old address [S-08]', async () => {
      const account = await ctx.account();
      await ctx.post('/v1/auth/password/forgot', { email: account.email });
      const reset = (await emailsTo(account.email)).findLast((queued) => queued.template === 'password_reset')?.payload
        .token;
      const target = newAddress();
      await request(await session(account), target);

      await confirm(await changeToken(target));

      const response = await ctx.post('/v1/auth/password/reset', {
        token: reset ?? '',
        new_password: 'a takeover attempt passphrase',
      });
      expect(response.statusCode).toBe(401);
    });
  });

  it('never writes an address or a token to the log [R-LOG-02]', async () => {
    const tokens = (await ctx.emails()).map((queued) => queued.payload.token).filter((token) => token !== undefined);

    for (const secret of ['@example.test', ...tokens]) expect(logs.text).not.toContain(secret);
  });
});
