import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startAccountsApp, type AccountsApp, type TestAccount } from '../helpers/accounts-app.ts';
import { contractInject } from '../helpers/contract.ts';
import { bearer } from '../helpers/goals.ts';
import {
  assert,
  otherKey,
  register,
  type CreationOptions,
  type RequestOptions,
  type SoftwarePasskey,
} from '../helpers/software-authenticator.ts';
import { totpCode } from '../helpers/totp.ts';

const ORIGIN = 'https://questline.test';
const STEP = 30_000;
const WRONG_PASSWORD = 'not the right passphrase';
const INVALID = { status: 401, type: 'urn:questline:problem:invalid-credentials' };
const SECOND_FACTOR_REQUIRED = { status: 401, type: 'urn:questline:problem:second-factor-required' };

interface Signed {
  readonly token: string;
  readonly sessionId: string;
}

interface Problem {
  readonly status: number;
  readonly type: string;
}

/** Shared steps of the suites: an app, a signed-in account, its passkeys and TOTP. */
function stepUpHelpers(app: () => AccountsApp) {
  const ctx = () => app();
  const signIn = async (who: TestAccount): Promise<Signed> => {
    const response = await ctx().post('/v1/auth/login', { email: who.email, password: who.password, client: 'ios' });
    expect(response.statusCode).toBe(200);
    const pair = response.json<{ access_token: string; session_id: string }>();
    return { token: pair.access_token, sessionId: pair.session_id };
  };
  const call = (method: 'POST' | 'DELETE', url: string, as: string, body?: unknown) =>
    contractInject(ctx().app, {
      method,
      url,
      headers: { ...bearer(as), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  const addPasskey = async (as: string): Promise<SoftwarePasskey> => {
    const options = (await call('POST', '/v1/me/passkeys/options', as)).json<CreationOptions>();
    const registered = register(options, { origin: ORIGIN });
    expect((await call('POST', '/v1/me/passkeys', as, { credential: registered.credential })).statusCode).toBe(201);
    return registered.passkey;
  };
  /** TOTP on; the clock a step past the confirming code. */
  const enableTotp = async (as: string): Promise<{ secret: string; codes: string[] }> => {
    const { secret } = (await call('POST', '/v1/me/totp', as)).json<{ secret: string }>();
    const confirmed = await call('POST', '/v1/me/totp/confirm', as, { code: totpCode(secret, ctx().clock.now()) });
    expect(confirmed.statusCode).toBe(200);
    ctx().clock.advance({ milliseconds: STEP });
    return { secret, codes: confirmed.json<{ recovery_codes: string[] }>().recovery_codes };
  };
  const requestOptions = async (): Promise<RequestOptions> => {
    const response = await contractInject(ctx().app, { method: 'POST', url: '/v1/auth/passkey/options' });
    expect(response.statusCode).toBe(200);
    return response.json<RequestOptions>();
  };
  const signed = async (passkey: SoftwarePasskey, settings: Parameters<typeof assert>[2] = { origin: ORIGIN }) =>
    assert(passkey, await requestOptions(), settings);
  const reauth = (as: string, body: Record<string, unknown>) => call('POST', '/v1/auth/reauth', as, body);
  const problemOf = (response: { statusCode: number; json: () => unknown }): Problem => ({
    status: response.statusCode,
    type: (response.json() as { type: string }).type,
  });
  return { signIn, call, addPasskey, enableTotp, requestOptions, signed, reauth, problemOf };
}

/** Step-up with a second factor or with a passkey (ADR-0019, R-AUTH-06, R-LOG-03). */
describe('step-up', () => {
  let ctx: AccountsApp;
  let account: TestAccount;
  let token: string;
  let sessionId: string;
  let passkey: SoftwarePasskey;
  let loggedInAt: Date;
  const { signIn, call, addPasskey, enableTotp, signed, reauth, problemOf, requestOptions } = stepUpHelpers(() => ctx);

  beforeAll(async () => {
    ctx = await startAccountsApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    ctx.clock.set('2026-11-04T12:00:10Z');
    loggedInAt = ctx.clock.now();
    account = await ctx.account();
    ({ token, sessionId } = await signIn(account));
    passkey = await addPasskey(token);
    ctx.clock.advance({ milliseconds: STEP });
  });

  const lastReauthAt = async () =>
    (await ctx.admin.sql<{ last_reauth_at: Date }[]>`select last_reauth_at from sessions where id = ${sessionId}`)[0]
      ?.last_reauth_at;
  const eventsOf = async (type: string, userId = account.userId) =>
    (
      await ctx.admin.sql<{ outcome: string; session_id: string | null; metadata: Record<string, string> }[]>`
        select outcome, session_id, metadata from audit_events where user_id = ${userId} and event_type = ${type}
        order by created_at`
    ).map((row) => ({ ...row }));
  const by = (outcome: 'success' | 'failure', metadata: Record<string, string> = {}) => ({
    outcome,
    session_id: sessionId,
    metadata,
  });
  const storedPasskey = async () =>
    (
      await ctx.admin.sql<{ sign_count: string; last_used_at: Date | null }[]>`
        select sign_count, last_used_at from passkeys where user_id = ${account.userId}`
    )[0];

  describe('with the password and TOTP on [ADR-0019]', () => {
    it('answers the password alone with 401 second-factor-required before checking it, and changes nothing', async () => {
      await enableTotp(token);
      const verified = ctx.verifyCount();

      for (const password of [account.password, WRONG_PASSWORD]) {
        expect(problemOf(await reauth(token, { password }))).toEqual(SECOND_FACTOR_REQUIRED);
      }

      expect(ctx.verifyCount()).toBe(verified);
      expect(await lastReauthAt()).toEqual(loggedInAt);
      expect(await eventsOf('reauth_failed')).toEqual([]);
      expect(await eventsOf('reauth_succeeded')).toEqual([]);
    });

    it('asks for a code after all when TOTP was turned on while the password was checked', async () => {
      await call('POST', '/v1/me/totp', token);
      ctx.afterPasswordVerified = async () => {
        ctx.afterPasswordVerified = undefined;
        await ctx.admin.sql`update totp_secrets set enabled_at = ${ctx.clock.now()} where user_id = ${account.userId}`;
      };

      expect(problemOf(await reauth(token, { password: account.password }))).toEqual(SECOND_FACTOR_REQUIRED);

      expect(await lastReauthAt()).toEqual(loggedInAt);
      expect(await eventsOf('reauth_succeeded')).toEqual([]);
    });

    it("steps up with the password and the app's current code, which is used up then", async () => {
      const { secret } = await enableTotp(token);
      const code = totpCode(secret, ctx.clock.now());

      expect((await reauth(token, { password: account.password, totp_code: code })).statusCode).toBe(204);

      expect(await lastReauthAt()).toEqual(ctx.clock.now());
      expect(await eventsOf('reauth_succeeded')).toEqual([by('success')]);
      expect(problemOf(await reauth(token, { password: account.password, totp_code: code }))).toEqual(INVALID);
    });

    it('refuses a wrong code like a wrong password, audited as a failed second factor', async () => {
      const { secret } = await enableTotp(token);

      const response = await reauth(token, {
        password: account.password,
        totp_code: totpCode(secret, ctx.clock.now(), 5),
      });

      expect(problemOf(response)).toEqual(INVALID);
      expect(await lastReauthAt()).toEqual(loggedInAt);
      expect(await eventsOf('second_factor_failed')).toEqual([by('failure')]);
      expect(await eventsOf('reauth_failed')).toEqual([]);
    });

    it('checks no code after a wrong password, so the code stays usable', async () => {
      const { secret, codes } = await enableTotp(token);
      const code = totpCode(secret, ctx.clock.now());

      expect(problemOf(await reauth(token, { password: WRONG_PASSWORD, totp_code: code }))).toEqual(INVALID);
      expect(problemOf(await reauth(token, { password: WRONG_PASSWORD, recovery_code: codes[0] }))).toEqual(INVALID);

      expect(await eventsOf('reauth_failed')).toEqual([by('failure'), by('failure')]);
      expect(await eventsOf('second_factor_failed')).toEqual([]);
      expect((await reauth(token, { password: account.password, totp_code: code })).statusCode).toBe(204);
      expect((await reauth(token, { password: account.password, recovery_code: codes[0] })).statusCode).toBe(204);
    });

    it('takes a recovery code once, audits it and tells the owner', async () => {
      const { codes } = await enableTotp(token);
      const [code] = codes;

      expect((await reauth(token, { password: account.password, recovery_code: code })).statusCode).toBe(204);

      expect(await lastReauthAt()).toEqual(ctx.clock.now());
      expect(await eventsOf('recovery_code_used')).toEqual([by('success')]);
      expect(await eventsOf('reauth_succeeded')).toEqual([by('success')]);
      const notices = (await ctx.emails()).filter(
        (email) => email.userId === account.userId && email.template === 'sign_in_methods_changed_notice',
      );
      expect(notices).toHaveLength(3);
      const [left] = await ctx.admin.sql<{ count: string }[]>`
        select count(*) from recovery_codes where user_id = ${account.userId}`;
      expect(left?.count).toBe('9');
      expect(problemOf(await reauth(token, { password: account.password, recovery_code: code }))).toEqual(INVALID);
    });

    it('checks no code while TOTP is off', async () => {
      expect((await reauth(token, { password: account.password, totp_code: '000000' })).statusCode).toBe(204);

      expect(await eventsOf('reauth_succeeded')).toEqual([by('success')]);
    });

    it('refuses two codes, a code or a password with a passkey, and neither a password nor a passkey', async () => {
      const credential = await signed(passkey);

      for (const body of [
        { password: account.password, totp_code: '123456', recovery_code: 'ABCD-EFGH-JKMN-PQRS' },
        { password: account.password, passkey: credential },
        { passkey: credential, totp_code: '123456' },
        { passkey: credential, recovery_code: 'ABCD-EFGH-JKMN-PQRS' },
        { totp_code: '123456' },
        {},
      ]) {
        expect((await reauth(token, body)).statusCode, JSON.stringify(Object.keys(body))).toBe(400);
      }
      expect(await lastReauthAt()).toEqual(loggedInAt);
    });
  });

  describe('locks', () => {
    /**
     * Sends the request while another transaction holds the account row as an update of anything but its key does
     * (what the step-up's own writes and foreign keys never wait for); `ready` resolves once only locks remain ahead.
     */
    async function whileAccountRowHeld(send: () => Promise<{ statusCode: number }>, ready: Promise<void>) {
      const released = Promise.withResolvers<undefined>();
      const held = Promise.withResolvers<undefined>();
      const holding = ctx.admin.sql.begin(async (sql) => {
        await sql`select id from users where id = ${account.userId} for no key update`;
        held.resolve(undefined);
        await released.promise;
      });
      await held.promise;
      const response = send();
      await ready;
      const early = await Promise.race([response.then(() => 'answered'), delay(300).then(() => 'waiting')]);
      released.resolve(undefined);
      await holding;
      return { early, status: (await response).statusCode };
    }

    it('takes the account row before its child rows, as the deletion does, with the password', async () => {
      const verified = Promise.withResolvers<undefined>();
      ctx.afterPasswordVerified = () => {
        ctx.afterPasswordVerified = undefined;
        verified.resolve(undefined);
        return Promise.resolve();
      };

      const result = await whileAccountRowHeld(() => reauth(token, { password: account.password }), verified.promise);

      expect(result).toEqual({ early: 'waiting', status: 204 });
    });

    it('takes the account row before its child rows, as the deletion does, with a passkey', async () => {
      const credential = await signed(passkey);

      const result = await whileAccountRowHeld(() => reauth(token, { passkey: credential }), Promise.resolve());

      expect(result).toEqual({ early: 'waiting', status: 204 });
    });
  });

  describe('with a passkey [ADR-0019]', () => {
    it("steps up with the account's passkey, without a code even with TOTP on, and keeps the login's method", async () => {
      await enableTotp(token);

      expect((await reauth(token, { passkey: await signed(passkey) })).statusCode).toBe(204);

      expect(await lastReauthAt()).toEqual(ctx.clock.now());
      expect(await eventsOf('reauth_succeeded')).toEqual([by('success', { method: 'passkey' })]);
      expect(await storedPasskey()).toEqual({ sign_count: '2', last_used_at: ctx.clock.now() });
      const [session] = await ctx.admin.sql<{ auth_method: string }[]>`
        select auth_method from sessions where id = ${sessionId}`;
      expect(session?.auth_method).toBe('password');
    });

    it("refuses another account's passkey and a forged signature with the same 401, audited", async () => {
      const other = await ctx.account();
      const theirs = await addPasskey((await signIn(other)).token);

      for (const credential of [
        await signed(theirs),
        await signed(passkey, { origin: ORIGIN, signWith: otherKey() }),
      ]) {
        expect(problemOf(await reauth(token, { passkey: credential }))).toEqual(INVALID);
      }

      expect(await lastReauthAt()).toEqual(loggedInAt);
      const failed = by('failure', { method: 'passkey' });
      expect(await eventsOf('reauth_failed')).toEqual([failed, failed]);
      expect(await storedPasskey()).toEqual({ sign_count: '1', last_used_at: null });
      const [their] = await ctx.admin.sql<{ sign_count: string }[]>`
        select sign_count from passkeys where user_id = ${other.userId}`;
      expect(their?.sign_count).toBe('1');
    });

    it("refuses the account's own passkey under a user handle naming another account", async () => {
      const elsewhere = Buffer.from(randomUUID().replaceAll('-', ''), 'hex').toString('base64url');

      const response = await reauth(token, {
        passkey: await signed(passkey, { origin: ORIGIN, userHandle: elsewhere }),
      });

      expect(problemOf(response)).toEqual(INVALID);
      expect(await eventsOf('reauth_failed')).toEqual([by('failure', { method: 'passkey' })]);
      expect(await lastReauthAt()).toEqual(loggedInAt);
    });

    it('refuses a counter that did not grow, audited as a possible clone', async () => {
      const response = await reauth(token, { passkey: await signed(passkey, { origin: ORIGIN, counter: 1 }) });

      expect(problemOf(response)).toEqual(INVALID);
      expect(await eventsOf('passkey_clone_suspected')).toEqual([by('failure')]);
      expect(await lastReauthAt()).toEqual(loggedInAt);
    });

    it('uses each challenge once, also when it refuses the result', async () => {
      const options = await requestOptions();
      const forged = assert(passkey, options, { origin: ORIGIN, signWith: otherKey() });
      const genuine = assert(passkey, options, { origin: ORIGIN });
      expect(problemOf(await reauth(token, { passkey: forged }))).toEqual(INVALID);
      expect(problemOf(await reauth(token, { passkey: genuine }))).toEqual(INVALID);

      const fresh = await signed(passkey);
      expect((await reauth(token, { passkey: fresh })).statusCode).toBe(204);
      expect(problemOf(await reauth(token, { passkey: fresh }))).toEqual(INVALID);
    });

    it('refuses a registration challenge and a result naming no challenge, account or credential, audited', async () => {
      const registration = (await call('POST', '/v1/me/passkeys/options', token)).json<{
        challenge: string;
      }>();
      const misused = assert(
        passkey,
        { challenge: registration.challenge, rpId: 'questline.test' },
        { origin: ORIGIN },
      );
      const credential = await signed(passkey);
      const response = (credential['response'] ?? {}) as Record<string, unknown>;
      const unreadable = { ...credential, response: { ...response, userHandle: 'bm90IGFuIGlk' } };

      for (const result of [misused, unreadable]) {
        expect(problemOf(await reauth(token, { passkey: result }))).toEqual(INVALID);
      }

      const failed = by('failure', { method: 'passkey' });
      expect(await eventsOf('reauth_failed')).toEqual([failed, failed]);
      expect(await lastReauthAt()).toEqual(loggedInAt);
    });
  });
});

/** Wrong codes and passwords count against the user's backoff; passkeys stay outside it (R-AUTH-08, S-01). */
describe('step-up and the backoff [R-AUTH-08, S-01]', () => {
  let ctx: AccountsApp;
  const { signIn, addPasskey, enableTotp, signed, reauth, problemOf } = stepUpHelpers(() => ctx);

  beforeAll(async () => {
    ctx = await startAccountsApp({ rateLimits: 'enforced' });
    ctx.clock.set('2026-11-04T12:00:10Z');
  });

  afterAll(async () => {
    await ctx.close();
  });

  const statuses = async (times: number, attempt: () => Promise<{ statusCode: number }>) => {
    const answered: number[] = [];
    for (let index = 0; index < times; index += 1) answered.push((await attempt()).statusCode);
    return answered;
  };

  it('counts wrong codes, while the answer for a missing code neither counts nor resets them', async () => {
    const account = await ctx.account();
    const { token } = await signIn(account);
    const { secret } = await enableTotp(token);
    const wrongCode = () =>
      reauth(token, { password: account.password, totp_code: totpCode(secret, ctx.clock.now(), 5) });

    expect(await statuses(3, wrongCode)).toEqual([401, 401, 401]);
    expect(problemOf(await reauth(token, { password: account.password }))).toEqual(SECOND_FACTOR_REQUIRED);
    expect(problemOf(await reauth(token, { password: account.password }))).toEqual(SECOND_FACTOR_REQUIRED);
    expect(await statuses(3, wrongCode)).toEqual([401, 401, 401]);

    const right = await reauth(token, { password: account.password, totp_code: totpCode(secret, ctx.clock.now()) });
    expect(right.statusCode).toBe(429);
  });

  it('lets a passkey step up while wrong passwords block the password, and counts no refused passkey', async () => {
    const blocked = await ctx.account();
    const blockedSession = await signIn(blocked);
    const blockedPasskey = await addPasskey(blockedSession.token);
    expect(await statuses(6, () => reauth(blockedSession.token, { password: WRONG_PASSWORD }))).toEqual([
      401, 401, 401, 401, 401, 401,
    ]);
    expect((await reauth(blockedSession.token, { password: blocked.password })).statusCode).toBe(429);

    expect((await reauth(blockedSession.token, { passkey: await signed(blockedPasskey) })).statusCode).toBe(204);

    const account = await ctx.account();
    const { token } = await signIn(account);
    const passkey = await addPasskey(token);
    const forged = async () =>
      reauth(token, { passkey: await signed(passkey, { origin: ORIGIN, signWith: otherKey() }) });
    expect(await statuses(6, forged)).toEqual([401, 401, 401, 401, 401, 401]);
    expect((await reauth(token, { password: account.password })).statusCode).toBe(204);
  });
});
