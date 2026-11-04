import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findPasskeyByCredential } from '../../src/modules/sign-in-methods/repository.ts';
import { createDatabase, inTransaction } from '../../src/platform/db/database.ts';
import { startAccountsApp, type AccountsApp, type TestAccount } from '../helpers/accounts-app.ts';
import { contractInject } from '../helpers/contract.ts';
import { bearer } from '../helpers/goals.ts';
import {
  assert,
  otherKey,
  register,
  type AssertionSettings,
  type CreationOptions,
  type RequestOptions,
  type SoftwarePasskey,
} from '../helpers/software-authenticator.ts';
import { totpCode } from '../helpers/totp.ts';

const ORIGIN = 'https://questline.test';
const MINUTE = 60_000;

/** Signing in with a passkey, without an address (ADR-0019, R-AUTH-01, R-AUTH-07, R-PRIV-06). */
describe('passkey sign-in', () => {
  let ctx: AccountsApp;
  let account: TestAccount;
  let token: string;
  let passkey: SoftwarePasskey;

  beforeAll(async () => {
    ctx = await startAccountsApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    ctx.clock.set('2026-11-04T12:00:10Z');
    account = await ctx.account();
    token = await passwordLogin(account);
    passkey = await addPasskey(token);
  });

  async function passwordLogin(who: TestAccount): Promise<string> {
    const response = await ctx.post('/v1/auth/login', { email: who.email, password: who.password, client: 'ios' });
    expect(response.statusCode).toBe(200);
    return response.json<{ access_token: string }>().access_token;
  }
  const call = (method: 'POST' | 'DELETE', url: string, as: string, body?: unknown) =>
    contractInject(ctx.app, {
      method,
      url,
      headers: { ...bearer(as), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  async function addPasskey(as: string): Promise<SoftwarePasskey> {
    const options = (await call('POST', '/v1/me/passkeys/options', as)).json<CreationOptions>();
    const registered = register(options, { origin: ORIGIN });
    expect((await call('POST', '/v1/me/passkeys', as, { credential: registered.credential })).statusCode).toBe(201);
    return registered.passkey;
  }
  const requestOptions = async (): Promise<RequestOptions> => {
    const response = await contractInject(ctx.app, { method: 'POST', url: '/v1/auth/passkey/options' });
    expect(response.statusCode).toBe(200);
    return response.json<RequestOptions>();
  };
  const signIn = async (settings: Partial<AssertionSettings> = {}, using = passkey) => {
    const credential = assert(using, await requestOptions(), { origin: ORIGIN, ...settings });
    return ctx.post('/v1/auth/passkey/login', { credential, client: 'android', device_label: 'Pixel 9' });
  };
  const refusedLike = (response: { statusCode: number; json: () => unknown }) => {
    expect({ status: response.statusCode, type: (response.json() as { type: string }).type }).toEqual({
      status: 401,
      type: 'urn:questline:problem:invalid-credentials',
    });
  };
  const stored = async () =>
    (
      await ctx.admin.sql<{ sign_count: string; last_used_at: Date | null; backed_up: boolean }[]>`
        select sign_count, last_used_at, backed_up from passkeys where user_id = ${account.userId}`
    )[0];
  const eventsOf = async (type: string) =>
    (
      await ctx.admin.sql<{ outcome: string; client: string | null; metadata: Record<string, string> }[]>`
        select outcome, client, metadata from audit_events where user_id = ${account.userId} and event_type = ${type}
        order by created_at`
    ).map((row) => ({ ...row }));
  const FAILED = { outcome: 'failure', client: 'android', metadata: { method: 'passkey' } };
  const failuresWithoutAccount = async () =>
    (
      await ctx.admin.sql<{ count: string }[]>`
        select count(*) from audit_events
        where user_id is null and event_type = 'login_failed' and metadata = '{"method": "passkey"}'::jsonb`
    )[0]?.count;

  it('hands out request options with a fresh challenge that names no account', async () => {
    const options = await requestOptions();

    expect(options).toEqual({
      challenge: expect.stringMatching(/^[\w-]{43}$/) as unknown,
      timeout: 300_000,
      rpId: 'questline.test',
      userVerification: 'required',
    });
    const [challenge] = await ctx.admin.sql<{ purpose: string; user_id: string | null; challenge_hash: Buffer }[]>`
      select purpose, user_id, challenge_hash from webauthn_challenges where purpose = 'authentication'
      order by created_at desc limit 1`;
    expect(challenge).toMatchObject({ purpose: 'authentication', user_id: null });
  });

  it('opens a session marked passkey, updates the counter and last use, and audits the login', async () => {
    const response = await signIn();

    expect(response.statusCode).toBe(200);
    expect(response.json<{ access_token: string }>().access_token).toMatch(/^ql_at_/);
    const sessions = await ctx.admin.sql<{ auth_method: string; client: string }[]>`
      select auth_method, client from sessions where user_id = ${account.userId} order by client`;
    expect(sessions).toEqual([
      { auth_method: 'passkey', client: 'android' },
      { auth_method: 'password', client: 'ios' },
    ]);
    expect(await stored()).toEqual({ sign_count: '2', last_used_at: ctx.clock.now(), backed_up: true });
    expect((await eventsOf('login_succeeded')).at(-1)).toEqual({ outcome: 'success', client: 'android', metadata: {} });
  });

  it('keeps the backup state the platform reports', async () => {
    expect((await signIn({ backedUp: false })).statusCode).toBe(200);

    expect(await stored()).toMatchObject({ sign_count: '2', backed_up: false });
  });

  it('uses each challenge once', async () => {
    const options = await requestOptions();
    const first = assert(passkey, options, { origin: ORIGIN });
    const second = assert(passkey, options, { origin: ORIGIN });

    expect((await ctx.post('/v1/auth/passkey/login', { credential: first, client: 'ios' })).statusCode).toBe(200);
    refusedLike(await ctx.post('/v1/auth/passkey/login', { credential: second, client: 'ios' }));
  });

  it('uses up the challenge of a refused result as well', async () => {
    const options = await requestOptions();
    const forged = assert(passkey, options, { origin: ORIGIN, signWith: otherKey() });
    const genuine = assert(passkey, options, { origin: ORIGIN });

    refusedLike(await ctx.post('/v1/auth/passkey/login', { credential: forged, client: 'ios' }));
    refusedLike(await ctx.post('/v1/auth/passkey/login', { credential: genuine, client: 'ios' }));
    expect(await stored()).toMatchObject({ sign_count: '1', last_used_at: null });
  });

  it('needs no second factor with TOTP on [ADR-0019]', async () => {
    const { secret } = (await call('POST', '/v1/me/totp', token)).json<{ secret: string }>();
    expect(
      (await call('POST', '/v1/me/totp/confirm', token, { code: totpCode(secret, ctx.clock.now()) })).statusCode,
    ).toBe(200);

    expect((await signIn()).statusCode).toBe(200);
  });

  it.each([
    ['another origin', { origin: 'https://evil.test' }],
    ['another relying party', { rpId: 'evil.test' }],
    ['no user verification', { userVerified: false }],
    ['a forged signature', { signWith: otherKey() }],
  ])('refuses %s with the uniform 401 and audits it [R-AUTH-07]', async (_label, settings) => {
    refusedLike(await signIn(settings));

    expect(await stored()).toMatchObject({ sign_count: '1', last_used_at: null });
    expect(await eventsOf('login_failed')).toEqual([FAILED]);
  });

  it('refuses a user handle of nobody with the uniform 401, audited without an account [R-AUTH-07]', async () => {
    const before = Number(await failuresWithoutAccount());

    refusedLike(
      await signIn({ userHandle: Buffer.from(randomUUID().replaceAll('-', ''), 'hex').toString('base64url') }),
    );

    expect(Number(await failuresWithoutAccount())).toBe(before + 1);
    expect(await stored()).toMatchObject({ sign_count: '1', last_used_at: null });
    expect(await eventsOf('login_failed')).toEqual([]);
  });

  it('refuses an account whose address is not verified, should it have a passkey', async () => {
    await ctx.admin.sql`update users set email_verified_at = null where id = ${account.userId}`;

    refusedLike(await signIn());
    expect(await eventsOf('login_failed')).toEqual([FAILED]);
  });

  it("refuses a passkey of another account under this account's user handle", async () => {
    const other = await ctx.account();
    const theirs = await addPasskey(await passwordLogin(other));

    refusedLike(await signIn({ userHandle: passkey.userHandle }, theirs));
    expect(await eventsOf('login_failed')).toEqual([FAILED]);
  });

  it("finds only the account's own credential by its own condition, where no policy restricts it", async () => {
    const theirs = await addPasskey(await passwordLogin(await ctx.account()));
    const find = (credentialId: Buffer) =>
      inTransaction(createDatabase(ctx.admin), (tx) => findPasskeyByCredential(tx, account.userId, credentialId));

    expect(await find(passkey.credentialId)).toBeDefined();
    expect(await find(theirs.credentialId)).toBeUndefined();
  });

  it('takes a challenge for 5 minutes, not longer, and refuses a registration challenge', async () => {
    const fresh = await requestOptions();
    ctx.clock.advance({ milliseconds: 5 * MINUTE - 1 });
    expect(
      (
        await ctx.post('/v1/auth/passkey/login', {
          credential: assert(passkey, fresh, { origin: ORIGIN }),
          client: 'ios',
        })
      ).statusCode,
    ).toBe(200);

    const options = await requestOptions();
    ctx.clock.advance({ milliseconds: 5 * MINUTE });
    refusedLike(
      await ctx.post('/v1/auth/passkey/login', {
        credential: assert(passkey, options, { origin: ORIGIN }),
        client: 'ios',
      }),
    );

    const registration = (await call('POST', '/v1/me/passkeys/options', await passwordLogin(account))).json<{
      challenge: string;
    }>();
    const misused = assert(passkey, { challenge: registration.challenge, rpId: 'questline.test' }, { origin: ORIGIN });
    refusedLike(await ctx.post('/v1/auth/passkey/login', { credential: misused, client: 'ios' }));
  });

  it('refuses a counter that did not grow, as a possible clone, and audits it', async () => {
    refusedLike(await signIn({ counter: 1 }));

    expect(await eventsOf('passkey_clone_suspected')).toEqual([
      { outcome: 'failure', client: 'android', metadata: {} },
    ]);
    expect(await stored()).toMatchObject({ sign_count: '1' });
  });

  it('refuses a removed passkey', async () => {
    const [row] = await ctx.admin.sql<{ id: string }[]>`select id from passkeys where user_id = ${account.userId}`;
    expect((await call('DELETE', `/v1/me/passkeys/${row?.id ?? ''}`, token)).statusCode).toBe(204);

    refusedLike(await signIn());
  });

  it('reactivates an account pending deletion within its 30 days, and refuses it after [R-PRIV-06]', async () => {
    expect((await call('DELETE', '/v1/me', token)).statusCode).toBe(202);

    expect((await signIn()).statusCode).toBe(200);
    const [row] = await ctx.admin.sql<{ deactivated_at: Date | null }[]>`
      select deactivated_at from users where id = ${account.userId}`;
    expect(row?.deactivated_at).toBeNull();
    expect(await eventsOf('account_reactivated')).toHaveLength(1);

    const fresh = await passwordLogin(account);
    expect((await call('DELETE', '/v1/me', fresh)).statusCode).toBe(202);
    ctx.clock.advance({ days: 30 });
    refusedLike(await signIn());
  });

  it('refuses a result that names no challenge, account or credential', async () => {
    const credential = assert(passkey, await requestOptions(), { origin: ORIGIN });
    const response = (credential['response'] ?? {}) as Record<string, unknown>;

    refusedLike(
      await ctx.post('/v1/auth/passkey/login', {
        credential: { ...credential, response: { ...response, userHandle: 'bm90IGFuIGlk' } },
        client: 'ios',
      }),
    );
  });
});
