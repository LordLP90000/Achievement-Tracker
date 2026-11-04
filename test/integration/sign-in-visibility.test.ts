import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startAccountsApp, type AccountsApp, type TestAccount } from '../helpers/accounts-app.ts';
import { contractInject } from '../helpers/contract.ts';
import { bearer } from '../helpers/goals.ts';
import { assert, register, type CreationOptions, type RequestOptions } from '../helpers/software-authenticator.ts';
import { totpCode } from '../helpers/totp.ts';

const ORIGIN = 'https://questline.test';
const STEP = 30_000;

interface Account {
  readonly version: number;
  readonly two_factor_enabled: boolean;
  readonly recovery_codes_left: number;
}

/** What the account and its sessions show of the sign-in methods (ADR-0019, Q-52). */
describe('the sign-in methods on the account and its sessions', () => {
  let ctx: AccountsApp;
  let account: TestAccount;
  let token: string;

  beforeAll(async () => {
    ctx = await startAccountsApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    ctx.clock.set('2026-11-04T12:00:10Z');
    account = await ctx.account();
    token = await login();
  });

  async function login(): Promise<string> {
    const response = await ctx.post('/v1/auth/login', {
      email: account.email,
      password: account.password,
      client: 'ios',
    });
    expect(response.statusCode).toBe(200);
    return response.json<{ access_token: string }>().access_token;
  }
  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    contractInject(ctx.app, {
      method,
      url,
      headers: { ...bearer(token), ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  const twoFactor = async () => {
    const body = (await call('GET', '/v1/me')).json<Account>();
    return { enabled: body.two_factor_enabled, left: body.recovery_codes_left };
  };
  /** TOTP on; the clock a step past the confirming code. */
  async function enableTotp(): Promise<{ secret: string; codes: string[] }> {
    const { secret } = (await call('POST', '/v1/me/totp')).json<{ secret: string }>();
    const confirmed = await call('POST', '/v1/me/totp/confirm', { code: totpCode(secret, ctx.clock.now()) });
    expect(confirmed.statusCode).toBe(200);
    ctx.clock.advance({ milliseconds: STEP });
    return { secret, codes: confirmed.json<{ recovery_codes: string[] }>().recovery_codes };
  }

  it('shows two-factor sign-in off and no recovery codes until TOTP is confirmed', async () => {
    expect(await twoFactor()).toEqual({ enabled: false, left: 0 });

    const { secret } = (await call('POST', '/v1/me/totp')).json<{ secret: string }>();
    expect(await twoFactor()).toEqual({ enabled: false, left: 0 });

    expect((await call('POST', '/v1/me/totp/confirm', { code: totpCode(secret, ctx.clock.now()) })).statusCode).toBe(
      200,
    );
    expect(await twoFactor()).toEqual({ enabled: true, left: 10 });
  });

  it('counts the recovery codes left, and shows none once TOTP is off', async () => {
    const { codes } = await enableTotp();

    const stepUp = await call('POST', '/v1/auth/reauth', { password: account.password, recovery_code: codes[0] });
    expect(stepUp.statusCode).toBe(204);
    expect(await twoFactor()).toEqual({ enabled: true, left: 9 });

    expect((await call('POST', '/v1/me/recovery-codes')).statusCode).toBe(200);
    expect(await twoFactor()).toEqual({ enabled: true, left: 10 });

    expect((await call('DELETE', '/v1/me/totp')).statusCode).toBe(204);
    expect(await twoFactor()).toEqual({ enabled: false, left: 0 });
  });

  it('shows TOTP on with no recovery code left once all are used', async () => {
    await enableTotp();
    await ctx.admin.sql`delete from recovery_codes where user_id = ${account.userId}`;

    expect(await twoFactor()).toEqual({ enabled: true, left: 0 });
  });

  it('shows them in the account an update returns as well', async () => {
    await enableTotp();
    const { version } = (await call('GET', '/v1/me')).json<Account>();

    const response = await call('PATCH', '/v1/me', { locale: 'de' }, { 'if-match': `"${String(version)}"` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ two_factor_enabled: true, recovery_codes_left: 10 });
  });

  it('shows how each session signed in', async () => {
    const options = (await call('POST', '/v1/me/passkeys/options')).json<CreationOptions>();
    const { credential, passkey } = register(options, { origin: ORIGIN });
    expect((await call('POST', '/v1/me/passkeys', { credential })).statusCode).toBe(201);
    const request = (
      await contractInject(ctx.app, { method: 'POST', url: '/v1/auth/passkey/options' })
    ).json<RequestOptions>();
    const assertion = assert(passkey, request, { origin: ORIGIN });
    expect((await ctx.post('/v1/auth/passkey/login', { credential: assertion, client: 'android' })).statusCode).toBe(
      200,
    );
    const { secret, codes } = await enableTotp();
    for (const code of [{ totp_code: totpCode(secret, ctx.clock.now()) }, { recovery_code: codes[0] }]) {
      const first = await ctx.post('/v1/auth/login', {
        email: account.email,
        password: account.password,
        client: 'ios',
      });
      const { second_factor_token: secondFactorToken } = first.json<{ second_factor_token: string }>();
      const second = await ctx.post('/v1/auth/login/second-factor', {
        second_factor_token: secondFactorToken,
        client: 'ios',
        ...code,
      });
      expect(second.statusCode).toBe(200);
    }

    const { items } = (await call('GET', '/v1/me/sessions')).json<{
      items: { auth_method: string; current: boolean }[];
    }>();

    expect(items.map((session) => session.auth_method).sort()).toEqual([
      'passkey',
      'password',
      'password_recovery_code',
      'password_totp',
    ]);
    expect(items.find((session) => session.current)?.auth_method).toBe('password');
  });
});
