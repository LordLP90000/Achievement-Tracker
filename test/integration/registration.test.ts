import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAccountsApp, type AccountsApp } from '../helpers/accounts-app.ts';
import { contractInject } from '../helpers/contract.ts';
import { LogCapture } from '../helpers/log-capture.ts';

const json = { 'content-type': 'application/json' };
const ACCEPTED = { message: 'If the request can be fulfilled, an email has been sent.' };
const PASSWORD = 'purple elephants dance quietly';
/** In the offline breach list (ADR-0012). */
const BREACHED = 'password1234';
const T0 = new Date('2026-10-29T12:00:00.000Z');

describe('registration and email verification [R-AUTH-02, R-AUTH-03, R-AUTH-09, R-AUTH-11, R-ENC-02]', () => {
  let ctx: AccountsApp;
  const logs = new LogCapture();
  const seen: string[] = [];

  const newEmail = () => {
    const email = `user-${randomUUID().slice(0, 8)}@example.test`;
    seen.push(email);
    return email;
  };
  const post = (url: string, body: unknown) =>
    contractInject(ctx.app, { method: 'POST', url, headers: json, payload: JSON.stringify(body) });
  const register = (body: Record<string, unknown>) => post('/v1/auth/register', body);
  const valid = (email: string, overrides: Record<string, unknown> = {}) => ({
    email,
    password: PASSWORD,
    privacy_policy_version: '2026-10-01',
    age_confirmed: true,
    ...overrides,
  });
  const verify = (token: string) => post('/v1/auth/verify-email', { token });
  const resend = (email: string) => post('/v1/auth/resend-verification', { email });
  const emailsTo = async (email: string) => (await ctx.emails()).filter((queued) => queued.payload.to === email);
  const userRow = async (email: string) => {
    const [row] = await ctx.worker.sql<Record<string, unknown>[]>`
      select * from users where email_blind_index = ${ctx.blindIndex(email)}`;
    return row;
  };
  const tokenOf = async (email: string) => {
    const queued = (await emailsTo(email)).filter((entry) => entry.template === 'verify_email').at(-1);
    if (queued?.payload.token === undefined) throw new Error(`no verification email for ${email}`);
    return queued.payload.token;
  };

  beforeAll(async () => {
    ctx = await startAccountsApp({ logCapture: logs });
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('POST /v1/auth/register', () => {
    it('creates an account with an encrypted email, a blind index and an Argon2id hash, and queues a verification email', async () => {
      const email = newEmail();
      const response = await register(valid(email));

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual(ACCEPTED);
      const user = await userRow(email);
      expect(user).toMatchObject({
        password_hash: expect.stringMatching(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/) as unknown,
        timezone: 'Europe/Zurich',
        locale: 'de-CH',
        week_start: 'monday',
        age_confirmed: true,
        privacy_policy_version: '2026-10-01',
        email_verified_at: null,
        deactivated_at: null,
        created_at: T0,
        password_changed_at: T0,
      });
      expect((user?.['email_enc'] as Buffer).includes(Buffer.from(email))).toBe(false);
      const [key] = await ctx.worker
        .sql`select kek_id, kek_version from user_keys where user_id = ${user?.['id'] as string}`;
      expect(key).toMatchObject({ kek_id: 'local', kek_version: 1 });

      const queued = await emailsTo(email);
      expect(queued).toMatchObject([{ template: 'verify_email', payload: { to: email, locale: 'de-CH' } }]);
      const token = queued[0]?.payload.token ?? '';
      expect(token).toMatch(/^ql_vt_[\w-]{43}$/);
      const tokens = await ctx.worker.sql<{ token_hash: Buffer; expires_at: Date }[]>`
        select token_hash, expires_at from one_time_tokens where user_id = ${user?.['id'] as string}`;
      expect(tokens).toEqual([
        { token_hash: createHash('sha256').update(token).digest(), expires_at: new Date(T0.getTime() + 30 * 60_000) },
      ]);
    });

    it('stores the chosen time zone in canonical form and the chosen locale', async () => {
      const email = newEmail();
      await register(valid(email, { timezone: 'america/new_york', locale: 'fr-CH' }));

      expect(await userRow(email)).toMatchObject({ timezone: 'America/New_York', locale: 'fr-CH' });
      expect(await emailsTo(email)).toMatchObject([{ payload: { locale: 'fr-CH' } }]);
    });

    it('sends a notice to the stored address instead of creating a second account, for any spelling of it', async () => {
      const email = newEmail();
      await register(valid(email));
      const response = await register(valid(email.toUpperCase(), { password: 'another fine passphrase' }));

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual(ACCEPTED);
      const [count] = await ctx.worker.sql<{ count: string }[]>`
        select count(*) from users where email_blind_index = ${ctx.blindIndex(email)}`;
      expect(count?.count).toBe('1');
      expect((await emailsTo(email)).map((queued) => queued.template)).toEqual(['verify_email', 'registration_notice']);
    });

    it('sends nothing to an account pending deletion [A-22]', async () => {
      const email = newEmail();
      await register(valid(email));
      await ctx.admin.sql`update users set deactivated_at = ${T0} where email_blind_index = ${ctx.blindIndex(email)}`;

      expect((await register(valid(email))).statusCode).toBe(202);
      expect((await emailsTo(email)).map((queued) => queued.template)).toEqual(['verify_email']);
    });

    it.each([
      ['missing', {}],
      ['false', { age_confirmed: false }],
    ])(
      'refuses a registration with %s age confirmation: 400, no account, no email [R-AUTH-11]',
      async (_name, change) => {
        const email = newEmail();
        const body: Record<string, unknown> = { ...valid(email), ...change };
        if (!('age_confirmed' in change)) delete body['age_confirmed'];
        const response = await register(body);

        expect(response.statusCode).toBe(400);
        expect(response.json()).toMatchObject({ errors: [{ pointer: '/age_confirmed' }] });
        expect(await userRow(email)).toBeUndefined();
        expect(await emailsTo(email)).toEqual([]);
      },
    );

    it.each([
      ['11 characters', 'x7Kp!m2q#Lw', 'is too short'],
      ['11 emoji (22 UTF-16 code units)', '😀'.repeat(11), 'is too short'],
      ['129 characters', 'Zq'.repeat(64) + 'x', 'is too long'],
      ['64 KiB of characters (not even counted)', 'Zq'.repeat(30_000), 'is too long'],
    ])('refuses a password of %s with 400 [R-AUTH-02]', async (_name, password, message) => {
      const response = await register(valid(newEmail(), { password }));

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ errors: [{ pointer: '/password', message }] });
    });

    it.each([
      ['12 characters', 'x7Kp!m2q#Lw9'],
      ['12 emoji', '🐉'.repeat(12)],
      ['128 characters', 'Zq'.repeat(64)],
    ])('accepts a password of %s', async (_name, password) => {
      expect((await register(valid(newEmail(), { password }))).statusCode).toBe(202);
    });

    it('refuses a breached password with 422 before looking at the email, so new and existing addresses answer alike', async () => {
      const existing = newEmail();
      await register(valid(existing));
      const fresh = newEmail();

      for (const email of [fresh, existing]) {
        const response = await register(valid(email, { password: BREACHED }));
        expect(response.statusCode).toBe(422);
        expect(response.json()).toMatchObject({ type: 'urn:questline:problem:weak-password', status: 422 });
      }
      expect(await userRow(fresh)).toBeUndefined();
      expect((await emailsTo(existing)).map((queued) => queued.template)).toEqual(['verify_email']);
    });

    it.each([
      ['an unknown property', { is_admin: true }, ''],
      ['an unsupported time zone', { timezone: 'Mars/Olympus' }, '/timezone'],
      ['a time offset instead of a zone', { timezone: '+01:00' }, '/timezone'],
      ['an unsupported locale', { locale: 'xx' }, '/locale'],
      ['a malformed policy version', { privacy_policy_version: 'latest' }, '/privacy_policy_version'],
    ])('refuses %s with 400', async (_name, change, pointer) => {
      const response = await register(valid(newEmail(), change));

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ errors: [{ pointer }] });
    });

    it('has no column for a date of birth [R-AUTH-11, R-PRIV-01]', async () => {
      const columns = await ctx.worker.sql<{ column_name: string }[]>`
        select column_name from information_schema.columns where table_name = 'users'`;

      expect(columns.filter((column) => /birth|dob|age(?!_confirmed)/.test(column.column_name))).toEqual([]);
    });
  });

  describe('POST /v1/auth/verify-email', () => {
    it('verifies the address with the emailed token and records the event with a truncated IP', async () => {
      const email = newEmail();
      await register(valid(email));
      ctx.clock.advance({ minutes: 5 });

      const response = await verify(await tokenOf(email));

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');
      const user = await userRow(email);
      expect(user?.['email_verified_at']).toEqual(ctx.clock.now());
      const events = await ctx.worker.sql`
        select event_type, outcome, ip_prefix, client from audit_events where user_id = ${user?.['id'] as string}`;
      expect(events.map((event) => ({ ...event }))).toEqual([
        { event_type: 'email_verified', outcome: 'success', ip_prefix: '127.0.0.0/24', client: null },
      ]);
    });

    it('answers a replayed token with 204 and changes nothing (the contract makes verification idempotent)', async () => {
      const email = newEmail();
      await register(valid(email));
      const token = await tokenOf(email);
      await verify(token);
      const verifiedAt = (await userRow(email))?.['email_verified_at'];
      ctx.clock.advance({ minutes: 1 });

      expect((await verify(token)).statusCode).toBe(204);
      expect((await userRow(email))?.['email_verified_at']).toEqual(verifiedAt);
      const [events] = await ctx.worker.sql<{ count: string }[]>`
        select count(*) from audit_events where user_id = ${(await userRow(email))?.['id'] as string}`;
      expect(events?.count).toBe('1');
    });

    it('refuses an unknown token, a token of another kind and a token older than 30 minutes with 401 [R-AUTH-03]', async () => {
      const email = newEmail();
      await register(valid(email));
      const token = await tokenOf(email);

      for (const presented of [`ql_vt_${'A'.repeat(43)}`, token.replace('ql_vt_', 'ql_pt_')]) {
        const response = await verify(presented);
        expect(response.statusCode).toBe(401);
        expect(response.json()).toMatchObject({ type: 'urn:questline:problem:invalid-token', status: 401 });
      }
      ctx.clock.advance({ minutes: 30, seconds: 1 });
      expect((await verify(token)).statusCode).toBe(401);
      expect((await userRow(email))?.['email_verified_at']).toBeNull();
    });

    it('refuses a malformed token with 400', async () => {
      expect((await verify('not-a-token')).statusCode).toBe(400);
    });

    it('leaves an address that is verified already unchanged and records no second event', async () => {
      const email = newEmail();
      await register(valid(email));
      const earlier = new Date(T0.getTime() - 60_000);
      await ctx.admin
        .sql`update users set email_verified_at = ${earlier} where email_blind_index = ${ctx.blindIndex(email)}`;

      expect((await verify(await tokenOf(email))).statusCode).toBe(204);
      const user = await userRow(email);
      expect(user).toMatchObject({ email_verified_at: earlier, version: 1 });
      const [events] = await ctx.worker.sql<{ count: string }[]>`
        select count(*) from audit_events where user_id = ${user?.['id'] as string}`;
      expect(events?.count).toBe('0');
    });
  });

  describe('POST /v1/auth/resend-verification', () => {
    it('sends a new token that supersedes the previous one [R-AUTH-03]', async () => {
      const email = newEmail();
      await register(valid(email));
      const first = await tokenOf(email);

      const response = await resend(email.toUpperCase());

      expect(response.statusCode).toBe(202);
      expect(response.json()).toEqual(ACCEPTED);
      const second = await tokenOf(email);
      expect(second).not.toBe(first);
      expect((await verify(first)).statusCode).toBe(401);
      expect((await verify(second)).statusCode).toBe(204);
    });

    it('sends nothing for a verified, an unknown or a deactivated address, with the same answer', async () => {
      const verified = newEmail();
      await register(valid(verified));
      await verify(await tokenOf(verified));
      const deactivated = newEmail();
      await register(valid(deactivated));
      await ctx.admin
        .sql`update users set deactivated_at = ${T0} where email_blind_index = ${ctx.blindIndex(deactivated)}`;
      const before = (await ctx.emails()).length;

      for (const email of [verified, newEmail(), deactivated]) {
        const response = await resend(email);
        expect(response.statusCode).toBe(202);
        expect(response.json()).toEqual(ACCEPTED);
      }
      expect((await ctx.emails()).length).toBe(before);
    });

    it('fails closed when the account data key is missing: 500, no email, nothing logged but the error name [R-ENC-01]', async () => {
      const email = newEmail();
      await register(valid(email));
      const user = await userRow(email);
      await ctx.admin.sql`delete from user_keys where user_id = ${user?.['id'] as string}`;

      // An internal failure is outside the contract (no operation documents 500): plain inject, generic problem.
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/v1/auth/resend-verification',
        headers: json,
        payload: JSON.stringify({ email }),
      });

      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({
        type: 'urn:questline:problem:internal',
        title: 'Internal Server Error',
        status: 500,
        instance: '/v1/auth/resend-verification',
        request_id: expect.any(String) as unknown,
      });
      const [queued] = await ctx.worker.sql<{ count: string }[]>`
        select count(*) from email_outbox where user_id = ${user?.['id'] as string}`;
      expect(queued?.count).toBe('1');
      expect(
        logs
          .records()
          .filter((record) => record['msg'] === 'request failed')
          .at(-1),
      ).toMatchObject({
        err: { name: 'MissingDataKeyError' },
      });
    });
  });

  it('never writes an address, a password or a token to the log [R-LOG-02]', async () => {
    const tokens = (await ctx.emails()).map((queued) => queued.payload.token).filter((token) => token !== undefined);

    expect(seen.length).toBeGreaterThan(10);
    for (const secret of [...seen, PASSWORD, BREACHED, ...tokens]) {
      expect(logs.text).not.toContain(secret);
    }
  });
});
