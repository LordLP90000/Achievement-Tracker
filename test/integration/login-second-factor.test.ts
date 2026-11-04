import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAccountsApp, type AccountsApp, type TestAccount } from '../helpers/accounts-app.ts';
import { contractInject } from '../helpers/contract.ts';
import { bearer } from '../helpers/goals.ts';
import { totpCode } from '../helpers/totp.ts';

const STEP = 30_000;
const MINUTE = 60_000;

interface SecondFactorRequired {
  readonly second_factor_token: string;
  readonly expires_in: number;
  readonly methods: string[];
}

interface Enabled {
  readonly account: TestAccount;
  readonly secret: string;
  readonly codes: string[];
}

const sha256 = (value: string) => createHash('sha256').update(value).digest();

/** The second step of a login with TOTP on (ADR-0019, Q-52, S-01, R-PRIV-06). */
describe('login with a second factor', () => {
  let ctx: AccountsApp;

  beforeAll(async () => {
    ctx = await startAccountsApp();
    ctx.clock.set('2026-11-04T12:00:10Z');
  });

  afterAll(async () => {
    await ctx.close();
  });

  const login = (account: TestAccount, password = account.password) =>
    ctx.post('/v1/auth/login', { email: account.email, password, client: 'ios' });
  const secondStep = (body: Record<string, unknown>) =>
    ctx.post('/v1/auth/login/second-factor', { client: 'android', ...body });
  const call = (method: 'POST' | 'DELETE', url: string, token: string, body?: unknown) =>
    contractInject(ctx.app, {
      method,
      url,
      headers: { ...bearer(token), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  const problemOf = (response: { statusCode: number; json: () => unknown }) => ({
    status: response.statusCode,
    type: (response.json() as { type: string }).type,
  });
  const nextStep = () => {
    ctx.clock.advance({ milliseconds: STEP });
  };

  /** A fresh verified account with TOTP on; the clock is a step past the confirming code. */
  async function enabledAccount(): Promise<Enabled> {
    const account = await ctx.account();
    const token = (await login(account)).json<{ access_token: string }>().access_token;
    const { secret } = (await call('POST', '/v1/me/totp', token)).json<{ secret: string }>();
    const confirmed = await call('POST', '/v1/me/totp/confirm', token, { code: totpCode(secret, ctx.clock.now()) });
    expect(confirmed.statusCode).toBe(200);
    nextStep();
    return { account, secret, codes: confirmed.json<{ recovery_codes: string[] }>().recovery_codes };
  }
  async function firstStep(account: TestAccount): Promise<SecondFactorRequired> {
    const response = await login(account);
    expect(response.statusCode).toBe(202);
    return response.json<SecondFactorRequired>();
  }
  const sessionsOf = async (userId: string) =>
    (
      await ctx.admin.sql<{ auth_method: string; client: string; revoked_at: Date | null }[]>`
        select auth_method, client, revoked_at from sessions where user_id = ${userId} order by created_at`
    ).map((row) => ({ ...row }));
  const eventsOf = async (userId: string, type: string) =>
    (
      await ctx.admin.sql<{ outcome: string; client: string | null }[]>`
        select outcome, client from audit_events where user_id = ${userId} and event_type = ${type}
        order by created_at`
    ).map((row) => ({ ...row }));

  it('answers a correct password with a 5-minute second-factor token instead of a session, stored as a hash', async () => {
    const { account } = await enabledAccount();
    const sessionsBefore = (await sessionsOf(account.userId)).length;

    const response = await login(account);

    expect(response.statusCode).toBe(202);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json<SecondFactorRequired>();
    expect(body).toEqual({
      second_factor_token: expect.stringMatching(/^ql_sf_[\w-]{43}$/) as unknown,
      expires_in: 300,
      methods: ['totp', 'recovery_code'],
    });
    const [stored] = await ctx.admin.sql<{ token_hash: Buffer; failed_attempts: number }[]>`
      select token_hash, failed_attempts from second_factor_challenges where user_id = ${account.userId}`;
    expect(stored).toEqual({ token_hash: sha256(body.second_factor_token), failed_attempts: 0 });
    expect(await sessionsOf(account.userId)).toHaveLength(sessionsBefore);
  });

  it('answers a wrong password with the same 401 as without TOTP [R-AUTH-07]', async () => {
    const { account } = await enabledAccount();

    expect(problemOf(await login(account, `${account.password} wrong`))).toEqual({
      status: 401,
      type: 'urn:questline:problem:invalid-credentials',
    });
  });

  it('completes the login with the current code: a session marked password_totp, audited, the token used up', async () => {
    const { account, secret } = await enabledAccount();
    const { second_factor_token: token } = await firstStep(account);
    const code = totpCode(secret, ctx.clock.now());

    const response = await secondStep({ second_factor_token: token, totp_code: code, device_label: 'Pixel 9' });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ access_token: string }>().access_token).toMatch(/^ql_at_/);
    expect((await sessionsOf(account.userId)).at(-1)).toEqual({
      auth_method: 'password_totp',
      client: 'android',
      revoked_at: null,
    });
    expect((await eventsOf(account.userId, 'login_succeeded')).at(-1)).toEqual({
      outcome: 'success',
      client: 'android',
    });
    expect(await ctx.admin.sql`select 1 from second_factor_challenges where user_id = ${account.userId}`).toHaveLength(
      0,
    );
    expect(problemOf(await secondStep({ second_factor_token: token, totp_code: code }))).toEqual({
      status: 401,
      type: 'urn:questline:problem:invalid-token',
    });
  });

  it('accepts no code twice, also not in another login', async () => {
    const { account, secret } = await enabledAccount();
    const code = totpCode(secret, ctx.clock.now());
    const first = await firstStep(account);
    expect((await secondStep({ second_factor_token: first.second_factor_token, totp_code: code })).statusCode).toBe(
      200,
    );
    const second = await firstStep(account);

    expect(problemOf(await secondStep({ second_factor_token: second.second_factor_token, totp_code: code }))).toEqual({
      status: 401,
      type: 'urn:questline:problem:invalid-credentials',
    });
    nextStep();
    expect(
      (
        await secondStep({
          second_factor_token: second.second_factor_token,
          totp_code: totpCode(secret, ctx.clock.now()),
        })
      ).statusCode,
    ).toBe(200);
  });

  it('completes the login with a recovery code, which then never works again, audited and told to the owner', async () => {
    const { account, codes } = await enabledAccount();
    const [code] = codes;
    const { second_factor_token: token } = await firstStep(account);

    const response = await secondStep({ second_factor_token: token, recovery_code: code?.toLowerCase() });

    expect(response.statusCode).toBe(200);
    expect((await sessionsOf(account.userId)).at(-1)?.auth_method).toBe('password_recovery_code');
    expect(await eventsOf(account.userId, 'recovery_code_used')).toEqual([{ outcome: 'success', client: 'android' }]);
    const notices = (await ctx.emails()).filter(
      (email) => email.userId === account.userId && email.template === 'sign_in_methods_changed_notice',
    );
    expect(notices).toHaveLength(2);
    const again = await firstStep(account);
    expect(
      problemOf(await secondStep({ second_factor_token: again.second_factor_token, recovery_code: code })),
    ).toEqual({
      status: 401,
      type: 'urn:questline:problem:invalid-credentials',
    });
  });

  it('offers only the TOTP code once no recovery code is left', async () => {
    const { account } = await enabledAccount();
    await ctx.admin.sql`delete from recovery_codes where user_id = ${account.userId}`;

    expect((await firstStep(account)).methods).toEqual(['totp']);
  });

  it('takes at most 5 wrong codes per token, each audited, and then refuses even the right one', async () => {
    const { account, secret } = await enabledAccount();
    const { second_factor_token: token } = await firstStep(account);
    const wrong = totpCode(secret, ctx.clock.now(), 5);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(problemOf(await secondStep({ second_factor_token: token, totp_code: wrong }))).toEqual({
        status: 401,
        type: 'urn:questline:problem:invalid-credentials',
      });
    }

    expect(
      problemOf(await secondStep({ second_factor_token: token, totp_code: totpCode(secret, ctx.clock.now()) })),
    ).toEqual({ status: 401, type: 'urn:questline:problem:invalid-token' });
    expect(await eventsOf(account.userId, 'second_factor_failed')).toHaveLength(5);
    ctx.clock.advance({ milliseconds: 15 * MINUTE });
  });

  it('lets a token live 5 minutes', async () => {
    const { account, secret } = await enabledAccount();
    const late = await firstStep(account);
    const inTime = await firstStep(account);
    ctx.clock.advance({ milliseconds: 5 * MINUTE - 1 });
    const code = totpCode(secret, ctx.clock.now());

    expect((await secondStep({ second_factor_token: inTime.second_factor_token, totp_code: code })).statusCode).toBe(
      200,
    );
    ctx.clock.advance({ milliseconds: 1 });
    nextStep();
    expect(
      problemOf(
        await secondStep({
          second_factor_token: late.second_factor_token,
          totp_code: totpCode(secret, ctx.clock.now()),
        }),
      ),
    ).toEqual({ status: 401, type: 'urn:questline:problem:invalid-token' });
  });

  it.each([
    ['both codes', { totp_code: '123456', recovery_code: 'ABCD-EFGH-JKMN-PQRS' }],
    ['no code', {}],
  ])('needs exactly one code, not %s', async (_label, codes) => {
    const { account } = await enabledAccount();
    const { second_factor_token: token } = await firstStep(account);

    expect((await secondStep({ second_factor_token: token, ...codes })).statusCode).toBe(400);
  });

  it('refuses a token of another kind or none at all', async () => {
    expect(
      problemOf(await secondStep({ second_factor_token: `ql_sf_${'A'.repeat(43)}`, totp_code: '123456' })),
    ).toEqual({ status: 401, type: 'urn:questline:problem:invalid-token' });
    expect(
      problemOf(await secondStep({ second_factor_token: `ql_at_${'A'.repeat(43)}`, totp_code: '123456' })),
    ).toEqual({ status: 401, type: 'urn:questline:problem:invalid-token' });
  });

  it('voids the token when the password changes, or TOTP is turned off, after the first step', async () => {
    const { account, secret } = await enabledAccount();
    const pending = await firstStep(account);
    const done = await firstStep(account);
    const session = (
      await secondStep({ second_factor_token: done.second_factor_token, totp_code: totpCode(secret, ctx.clock.now()) })
    ).json<{ access_token: string }>().access_token;
    ctx.clock.advance({ milliseconds: 1000 });
    const newPassword = `${account.password} renewed`;
    expect(
      (
        await call('POST', '/v1/me/password', session, {
          current_password: account.password,
          new_password: newPassword,
        })
      ).statusCode,
    ).toBe(204);
    nextStep();

    expect(
      problemOf(
        await secondStep({
          second_factor_token: pending.second_factor_token,
          totp_code: totpCode(secret, ctx.clock.now()),
        }),
      ),
    ).toEqual({ status: 401, type: 'urn:questline:problem:invalid-token' });

    const renewed = { ...account, password: newPassword };
    const beforeOff = await firstStep(renewed);
    // Turned off and started again: an unconfirmed secret is no second factor.
    await ctx.admin.sql`update totp_secrets set enabled_at = null where user_id = ${account.userId}`;
    expect(
      problemOf(
        await secondStep({
          second_factor_token: beforeOff.second_factor_token,
          totp_code: totpCode(secret, ctx.clock.now()),
        }),
      ),
    ).toEqual({ status: 401, type: 'urn:questline:problem:invalid-token' });
    expect((await login(renewed)).statusCode).toBe(200);
  });

  it('lets one of two simultaneous uses of a token through, also with two different valid codes', async () => {
    const { account, secret, codes } = await enabledAccount();
    const { second_factor_token: token } = await firstStep(account);

    const results = await Promise.all([
      secondStep({ second_factor_token: token, totp_code: totpCode(secret, ctx.clock.now()) }),
      secondStep({ second_factor_token: token, recovery_code: codes[0] }),
    ]);

    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 401]);
    expect((await sessionsOf(account.userId)).filter((session) => session.auth_method !== 'password')).toHaveLength(1);
  });

  it('lets one of two simultaneous uses of a token and code through', async () => {
    const { account, secret } = await enabledAccount();
    const { second_factor_token: token } = await firstStep(account);
    const code = totpCode(secret, ctx.clock.now());

    const results = await Promise.all([
      secondStep({ second_factor_token: token, totp_code: code }),
      secondStep({ second_factor_token: token, totp_code: code }),
    ]);

    expect(results.map((result) => result.statusCode).sort()).toEqual([200, 401]);
  });

  it('reactivates an account pending deletion only once the second step succeeds [R-PRIV-06]', async () => {
    const { account, secret } = await enabledAccount();
    const { second_factor_token: first } = await firstStep(account);
    const session = (
      await secondStep({ second_factor_token: first, totp_code: totpCode(secret, ctx.clock.now()) })
    ).json<{ access_token: string }>().access_token;
    expect((await call('DELETE', '/v1/me', session)).statusCode).toBe(202);
    nextStep();
    const deactivated = async () =>
      (
        await ctx.admin.sql<{ deactivated_at: Date | null }[]>`
        select deactivated_at from users where id = ${account.userId}`
      )[0]?.deactivated_at ?? null;

    const { second_factor_token: token } = await firstStep(account);

    expect(await deactivated()).not.toBeNull();
    expect(
      (await secondStep({ second_factor_token: token, totp_code: totpCode(secret, ctx.clock.now()) })).statusCode,
    ).toBe(200);
    expect(await deactivated()).toBeNull();
    expect(await eventsOf(account.userId, 'account_reactivated')).toHaveLength(1);
  });
});

/** With the real limiter: wrong codes count against the address's login backoff (S-01). */
describe('login with a second factor, rate limited', () => {
  let ctx: AccountsApp;

  beforeAll(async () => {
    ctx = await startAccountsApp({ rateLimits: 'enforced' });
    ctx.clock.set('2026-11-04T12:00:10Z');
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('counts wrong codes against the account backoff, so a new first step cannot reset them [S-01]', async () => {
    const account = await ctx.account();
    const login = () => ctx.post('/v1/auth/login', { email: account.email, password: account.password, client: 'ios' });
    const token = (await login()).json<{ access_token: string }>().access_token;
    const call = (url: string, body?: unknown) =>
      contractInject(ctx.app, {
        method: 'POST',
        url,
        headers: { ...bearer(token), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
      });
    const { secret } = (await call('/v1/me/totp')).json<{ secret: string }>();
    expect((await call('/v1/me/totp/confirm', { code: totpCode(secret, ctx.clock.now()) })).statusCode).toBe(200);
    ctx.clock.advance({ milliseconds: STEP });
    const wrong = totpCode(secret, ctx.clock.now(), 5);
    const secondStep = (secondFactorToken: string, code: string) =>
      ctx.post('/v1/auth/login/second-factor', {
        second_factor_token: secondFactorToken,
        totp_code: code,
        client: 'ios',
      });
    let lastToken = '';
    for (const attempts of [5, 1]) {
      const first = await login();
      expect(first.statusCode).toBe(202);
      lastToken = first.json<SecondFactorRequired>().second_factor_token;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        expect((await secondStep(lastToken, wrong)).statusCode).toBe(401);
      }
    }

    const blocked = await login();

    expect(blocked.statusCode).toBe(429);
    expect(blocked.headers['retry-after']).toBe('60');
    expect((await secondStep(lastToken, totpCode(secret, ctx.clock.now()))).statusCode).toBe(429);
    ctx.clock.advance({ milliseconds: MINUTE });
    expect((await login()).statusCode).toBe(202);
  });
});
