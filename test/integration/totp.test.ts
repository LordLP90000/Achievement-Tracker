import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startAccountsApp, type AccountsApp, type TestAccount } from '../helpers/accounts-app.ts';
import { contractInject } from '../helpers/contract.ts';
import { bearer } from '../helpers/goals.ts';
import { totpCode } from '../helpers/totp.ts';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const RECOVERY_CODE = /^[0-9A-HJKMNP-TV-Z]{4}(?:-[0-9A-HJKMNP-TV-Z]{4}){3}$/;

interface Enrolment {
  readonly secret: string;
  readonly otpauth_uri: string;
}

/** Turning TOTP on and off and replacing recovery codes (ADR-0019, Q-53, R-AUTH-06, R-LOG-03). */
describe('two-factor authentication: TOTP and recovery codes', () => {
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

  const call = (method: 'POST' | 'DELETE', url: string, body?: unknown) =>
    contractInject(ctx.app, {
      method,
      url,
      headers: { ...bearer(token), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  const start = async (): Promise<Enrolment> => {
    const response = await call('POST', '/v1/me/totp');
    expect(response.statusCode).toBe(200);
    return response.json<Enrolment>();
  };
  const confirm = (code: string) => call('POST', '/v1/me/totp/confirm', { code });
  const enable = async (): Promise<{ secret: string; codes: string[] }> => {
    const { secret } = await start();
    const response = await confirm(totpCode(secret, ctx.clock.now()));
    expect(response.statusCode).toBe(200);
    return { secret, codes: response.json<{ recovery_codes: string[] }>().recovery_codes };
  };
  const stored = async () => {
    const [row] = await ctx.admin.sql<
      { secret_enc: Buffer; enabled_at: Date | null; last_used_step: string | null; created_at: Date }[]
    >`select secret_enc, enabled_at, last_used_step, created_at from totp_secrets where user_id = ${account.userId}`;
    return row;
  };
  const recoveryHashes = async () =>
    (
      await ctx.admin.sql<{ code_hash: Buffer }[]>`
        select code_hash from recovery_codes where user_id = ${account.userId} order by code_hash`
    ).map((row) => row.code_hash.toString('hex'));
  const events = async (type: string) =>
    (
      await ctx.admin.sql<{ outcome: string; session_id: string | null }[]>`
        select outcome, session_id from audit_events where user_id = ${account.userId} and event_type = ${type}`
    ).map((row) => ({ ...row }));
  const notices = async () =>
    (await ctx.emails()).filter(
      (email) => email.userId === account.userId && email.template === 'sign_in_methods_changed_notice',
    );
  const expectProblem = (response: Awaited<ReturnType<typeof call>>, status: number, slug: string) => {
    expect(response.statusCode).toBe(status);
    expect(response.json<{ type: string }>().type).toBe(`urn:questline:problem:${slug}`);
  };

  describe('starting', () => {
    it('hands out a new secret once, for an authenticator app, and changes nothing for login yet', async () => {
      const response = await call('POST', '/v1/me/totp');

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const enrolment = response.json<Enrolment & Record<string, unknown>>();
      expect(enrolment).toMatchObject({ algorithm: 'SHA1', digits: 6, period: 30 });
      expect(enrolment.secret).toMatch(/^[A-Z2-7]{32}$/);
      expect(enrolment.otpauth_uri).toBe(
        `otpauth://totp/Questline:${encodeURIComponent(account.email)}?secret=${enrolment.secret}&issuer=Questline` +
          '&algorithm=SHA1&digits=6&period=30',
      );
      const row = await stored();
      expect(row).toMatchObject({ enabled_at: null, last_used_step: null });
      expect(row?.secret_enc.toString('latin1')).not.toContain(enrolment.secret);
      expect(await login()).toMatch(/^ql_at_/);
    });

    it('replaces an unconfirmed secret when started again: only the new one confirms', async () => {
      const first = await start();
      const second = await start();

      expect(second.secret).not.toBe(first.secret);
      expectProblem(await confirm(totpCode(first.secret, ctx.clock.now())), 422, 'invalid-code');
      expect((await confirm(totpCode(second.secret, ctx.clock.now()))).statusCode).toBe(200);
    });

    it('refuses to start while TOTP is on', async () => {
      await enable();

      expectProblem(await call('POST', '/v1/me/totp'), 409, 'totp-enabled');
    });
  });

  describe('confirming', () => {
    it('turns TOTP on with a current code and returns 10 recovery codes, stored only as digests [R-AUTH-03]', async () => {
      const { secret } = await start();
      const code = totpCode(secret, ctx.clock.now());

      const response = await confirm(code);

      expect(response.statusCode).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      const codes = response.json<{ recovery_codes: string[] }>().recovery_codes;
      expect(codes).toHaveLength(10);
      expect(new Set(codes).size).toBe(10);
      for (const recoveryCode of codes) expect(recoveryCode).toMatch(RECOVERY_CODE);
      expect(await stored()).toMatchObject({
        enabled_at: ctx.clock.now(),
        last_used_step: String(Math.floor(ctx.clock.now().getTime() / 30_000)),
      });
      const hashes = await recoveryHashes();
      expect(hashes).toHaveLength(10);
      expect(hashes.join()).not.toContain(Buffer.from(codes[0] ?? '').toString('hex'));
      expect(await events('totp_enabled')).toEqual([{ outcome: 'success', session_id: expect.any(String) as unknown }]);
      expect(await notices()).toEqual([
        expect.objectContaining({ payload: { to: account.email, locale: 'de-CH' } }) as unknown,
      ]);
    });

    it('accepts the code of the step before or after, for a clock that drifts', async () => {
      const { secret } = await start();

      expect((await confirm(totpCode(secret, ctx.clock.now(), -1))).statusCode).toBe(200);
    });

    it.each([
      ['a code two steps old', -2],
      ['a code two steps ahead', 2],
    ])('refuses %s and changes nothing', async (_label, offset) => {
      const { secret } = await start();

      expectProblem(await confirm(totpCode(secret, ctx.clock.now(), offset)), 422, 'invalid-code');
      expect(await stored()).toMatchObject({ enabled_at: null });
      expect(await recoveryHashes()).toEqual([]);
      expect(await events('totp_enabled')).toEqual([]);
    });

    it('refuses a code when nothing was started, or when TOTP is on already', async () => {
      expectProblem(await confirm('123456'), 409, 'totp-not-started');
      const { secret } = await enable();

      expectProblem(await confirm(totpCode(secret, ctx.clock.now(), 1)), 409, 'totp-enabled');
    });

    it('treats a secret not confirmed within 24 hours as never started, even before the purge [Q-53]', async () => {
      const expired = await start();
      ctx.clock.advance({ milliseconds: DAY });
      token = await login();

      expectProblem(await confirm(totpCode(expired.secret, ctx.clock.now())), 409, 'totp-not-started');

      const { secret } = await start();
      ctx.clock.advance({ milliseconds: DAY - 1 });
      token = await login();
      expect((await confirm(totpCode(secret, ctx.clock.now()))).statusCode).toBe(200);
    });

    it('confirms against the secret as it is when its row is free: a secret replaced meanwhile is not turned on', async () => {
      const first = await start();
      const firstSecret = (await stored())?.secret_enc;
      const second = await start();
      const secondSecret = (await stored())?.secret_enc;
      await ctx.admin
        .sql`update totp_secrets set secret_enc = ${firstSecret ?? null} where user_id = ${account.userId}`;
      // Another device starts again while this confirmation runs.
      const { promise: released, resolve: release } = Promise.withResolvers<undefined>();
      const { promise: isLocked, resolve: locked } = Promise.withResolvers<undefined>();
      const restart = ctx.admin.sql.begin(async (tx) => {
        await tx`select 1 from totp_secrets where user_id = ${account.userId} for update`;
        locked(undefined);
        await released;
        await tx`update totp_secrets set secret_enc = ${secondSecret ?? null} where user_id = ${account.userId}`;
      });
      await isLocked;

      const confirmation = confirm(totpCode(first.secret, ctx.clock.now()));
      await expect.poll(waitingForLocks, { timeout: 5000, interval: 10 }).toBe(1);
      release(undefined);
      await restart;

      expectProblem(await confirmation, 422, 'invalid-code');
      expect(await stored()).toMatchObject({ enabled_at: null });
      expect((await confirm(totpCode(second.secret, ctx.clock.now()))).statusCode).toBe(200);
    });
  });

  describe('replacing recovery codes', () => {
    it('issues 10 new codes and voids the old ones', async () => {
      const { codes: old } = await enable();
      const before = await recoveryHashes();

      const response = await call('POST', '/v1/me/recovery-codes');

      expect(response.statusCode).toBe(200);
      const codes = response.json<{ recovery_codes: string[] }>().recovery_codes;
      expect(codes).toHaveLength(10);
      expect(codes.filter((code) => old.includes(code))).toEqual([]);
      const after = await recoveryHashes();
      expect(after).toHaveLength(10);
      expect(after.filter((hash) => before.includes(hash))).toEqual([]);
      expect(await events('recovery_codes_generated')).toEqual([
        { outcome: 'success', session_id: expect.any(String) as unknown },
      ]);
      expect(await notices()).toHaveLength(2);
    });

    it('refuses while TOTP is off, also with only an unconfirmed secret', async () => {
      expectProblem(await call('POST', '/v1/me/recovery-codes'), 409, 'totp-not-enabled');
      await start();

      expectProblem(await call('POST', '/v1/me/recovery-codes'), 409, 'totp-not-enabled');
      expect(await recoveryHashes()).toEqual([]);
    });
  });

  describe('turning off', () => {
    it('deletes the secret and the recovery codes', async () => {
      await enable();

      const response = await call('DELETE', '/v1/me/totp');

      expect(response.statusCode).toBe(204);
      expect(await stored()).toBeUndefined();
      expect(await recoveryHashes()).toEqual([]);
      expect(await events('totp_disabled')).toEqual([
        { outcome: 'success', session_id: expect.any(String) as unknown },
      ]);
      expect(await notices()).toHaveLength(2);
    });

    it('refuses while TOTP is off and keeps an unconfirmed secret', async () => {
      expectProblem(await call('DELETE', '/v1/me/totp'), 409, 'totp-not-enabled');
      await start();

      expectProblem(await call('DELETE', '/v1/me/totp'), 409, 'totp-not-enabled');
      expect(await stored()).toMatchObject({ enabled_at: null });
    });
  });

  it.each([
    ['start', 'POST', '/v1/me/totp', undefined],
    ['confirm', 'POST', '/v1/me/totp/confirm', { code: '123456' }],
    ['replace codes', 'POST', '/v1/me/recovery-codes', undefined],
    ['turn off', 'DELETE', '/v1/me/totp', undefined],
  ] as const)('requires the password within 10 minutes to %s [R-AUTH-06]', async (_label, method, url, body) => {
    ctx.clock.advance({ milliseconds: 10 * MINUTE });

    expectProblem(await call(method, url, body), 403, 'reauthentication-required');
    expect(await stored()).toBeUndefined();
  });

  async function waitingForLocks(): Promise<number | undefined> {
    const [row] = await ctx.admin.sql<{ count: number }[]>`
      select count(*)::int as count from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock'`;
    return row?.count;
  }
});
