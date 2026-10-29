import { createHash } from 'node:crypto';
import sodium from 'sodium-native';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAccountsApp, type AccountsApp, type TestAccount } from '../helpers/accounts-app.ts';
import { LogCapture } from '../helpers/log-capture.ts';

const T0 = new Date('2026-10-29T12:00:00.000Z');
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const sha256 = (value: string) => createHash('sha256').update(value).digest();

interface TokenPair {
  token_type: string;
  access_token: string;
  access_expires_in: number;
  refresh_token: string;
  refresh_expires_in: number;
  session_id: string;
}

describe('login [R-AUTH-04, R-AUTH-09, R-AUTH-10, R-PRIV-06, Q-29]', () => {
  let ctx: AccountsApp;
  const logs = new LogCapture();

  const login = (account: Pick<TestAccount, 'email' | 'password'>, extra: Record<string, unknown> = {}) =>
    ctx.post('/v1/auth/login', { email: account.email, password: account.password, client: 'ios', ...extra });
  const sessionsOf = (userId: string) =>
    ctx.worker.sql<Record<string, unknown>[]>`select * from sessions where user_id = ${userId} order by created_at`;
  const eventsOf = async (userId: string | null, type: string) =>
    (
      await ctx.worker.sql<Record<string, unknown>[]>`
        select event_type, outcome, session_id, ip_prefix, client, metadata from audit_events
        where user_id is not distinct from ${userId} and event_type = ${type} order by created_at`
    ).map((row) => ({ ...row }));
  const userRow = async (userId: string) =>
    (await ctx.worker.sql<Record<string, unknown>[]>`select * from users where id = ${userId}`)[0];

  beforeAll(async () => {
    ctx = await startAccountsApp({ logCapture: logs });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('opens a device session and returns opaque tokens that are stored only as hashes', async () => {
    const account = await ctx.account();
    ctx.clock.set('2026-10-29T12:00:00Z');

    const response = await login(account, { device_label: 'Anna’s iPhone' });

    expect(response.statusCode).toBe(200);
    const pair = response.json<TokenPair>();
    expect(pair).toEqual({
      token_type: 'Bearer',
      access_token: expect.stringMatching(/^ql_at_[\w-]{43}$/) as unknown,
      access_expires_in: 900,
      refresh_token: expect.stringMatching(/^ql_rt_[\w-]{43}$/) as unknown,
      refresh_expires_in: 30 * 24 * 3600,
      session_id: expect.any(String) as unknown,
    });
    expect(response.headers['cache-control']).toBe('no-store');
    const [session] = await sessionsOf(account.userId);
    expect(session).toMatchObject({
      id: pair.session_id,
      client: 'ios',
      created_at: T0,
      last_used_at: T0,
      last_reauth_at: T0,
      absolute_expires_at: new Date(T0.getTime() + 180 * DAY),
      revoked_at: null,
    });
    const label = session?.['device_label_enc'] as Buffer;
    expect(label.includes(Buffer.from('iPhone'))).toBe(false);
    expect(await ctx.decrypt(account.userId, pair.session_id, 'device_label_enc', label)).toBe('Anna’s iPhone');
    const tokens = await ctx.worker.sql`select * from session_tokens where session_id = ${pair.session_id}`;
    expect(tokens.map((row) => ({ ...row }))).toEqual([
      expect.objectContaining({
        user_id: account.userId,
        generation: 1,
        access_token_hash: sha256(pair.access_token),
        access_expires_at: new Date(T0.getTime() + 15 * MINUTE),
        refresh_token_hash: sha256(pair.refresh_token),
        refresh_expires_at: new Date(T0.getTime() + 30 * DAY),
        rotated_at: null,
      }),
    ]);
    expect(await eventsOf(account.userId, 'login_succeeded')).toEqual([
      {
        event_type: 'login_succeeded',
        outcome: 'success',
        session_id: pair.session_id,
        ip_prefix: '127.0.0.0/24',
        client: 'ios',
        metadata: {},
      },
    ]);
  });

  it('stores no device label when none is given', async () => {
    const account = await ctx.account();

    await login(account, { client: 'android' });

    expect(await sessionsOf(account.userId)).toMatchObject([{ client: 'android', device_label_enc: null }]);
  });

  it('refuses a wrong password with 401 invalid-credentials and audits the failure', async () => {
    const account = await ctx.account();

    const response = await login({ ...account, password: 'not the right passphrase' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ type: 'urn:questline:problem:invalid-credentials', status: 401 });
    expect(await sessionsOf(account.userId)).toEqual([]);
    expect(await eventsOf(account.userId, 'login_failed')).toMatchObject([{ outcome: 'failure', client: 'ios' }]);
  });

  it('refuses an unknown address like a wrong password and audits it without a user', async () => {
    const before = (await eventsOf(null, 'login_failed')).length;

    const response = await login({ email: 'nobody@example.test', password: 'whatever passphrase' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ type: 'urn:questline:problem:invalid-credentials' });
    expect((await eventsOf(null, 'login_failed')).length).toBe(before + 1);
  });

  it('refuses an unverified account with 403 only when the password is correct [R-AUTH-09, I-05]', async () => {
    const account = await ctx.account({ verified: false });

    const correct = await login(account);
    const wrong = await login({ ...account, password: 'not the right passphrase' });

    expect(correct.statusCode).toBe(403);
    expect(correct.json()).toMatchObject({ type: 'urn:questline:problem:email-not-verified', status: 403 });
    expect(wrong.statusCode).toBe(401);
    expect(await sessionsOf(account.userId)).toEqual([]);
  });

  it('reactivates an account pending deletion within 30 days and audits it [R-PRIV-06, A-22]', async () => {
    const account = await ctx.account();
    const requested = new Date(ctx.clock.now().getTime() - 30 * DAY + MINUTE);
    await ctx.admin.sql`update users set deactivated_at = ${requested} where id = ${account.userId}`;

    const response = await login(account);

    expect(response.statusCode).toBe(200);
    expect(await userRow(account.userId)).toMatchObject({ deactivated_at: null, version: 3 });
    expect(await eventsOf(account.userId, 'account_reactivated')).toMatchObject([{ outcome: 'success' }]);
  });

  it('treats an account whose 30-day grace period is over as deleted, even before the purge job ran', async () => {
    const account = await ctx.account();
    const requested = new Date(ctx.clock.now().getTime() - 30 * DAY);
    await ctx.admin.sql`update users set deactivated_at = ${requested} where id = ${account.userId}`;

    const response = await login(account);

    expect(response.statusCode).toBe(401);
    expect(await userRow(account.userId)).toMatchObject({ deactivated_at: requested });
    expect(await eventsOf(account.userId, 'login_failed')).toEqual([]);
  });

  it('upgrades a password hash with weaker parameters after a successful login [ADR-0005]', async () => {
    const account = await ctx.account();
    const weak = Buffer.alloc(sodium.crypto_pwhash_STRBYTES);
    sodium.crypto_pwhash_str(weak, Buffer.from(account.password), 2, 19 * 1024 * 1024);
    const weakHash = weak.subarray(0, weak.indexOf(0)).toString();
    await ctx.admin.sql`update users set password_hash = ${weakHash} where id = ${account.userId}`;

    expect((await login(account)).statusCode).toBe(200);
    const upgraded = (await userRow(account.userId))?.['password_hash'] as string;
    expect(upgraded).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect((await login(account)).statusCode).toBe(200);
  });

  it('lets a password change that happens during the login win: no session for the old password', async () => {
    const account = await ctx.account();
    ctx.afterPasswordVerified = async () => {
      await ctx.admin.sql`update users set password_hash = 'changed-meanwhile' where id = ${account.userId}`;
    };
    try {
      expect((await login(account)).statusCode).toBe(401);
    } finally {
      ctx.afterPasswordVerified = undefined;
    }
    expect(await sessionsOf(account.userId)).toEqual([]);
  });

  it('logs out the least recently used session when a login would open a 21st one [Q-29, R-IN-01]', async () => {
    const account = await ctx.account();
    const pairs: TokenPair[] = [];
    for (let index = 0; index < 20; index += 1) {
      ctx.clock.advance({ minutes: 1 });
      pairs.push((await login(account)).json<TokenPair>());
    }
    // The first session was used most recently, so the second one is the least recently used.
    await ctx.admin.sql`update sessions set last_used_at = ${ctx.clock.now()} where id = ${pairs[0]?.session_id ?? ''}`;
    ctx.clock.advance({ minutes: 1 });

    const response = await login(account);

    expect(response.statusCode).toBe(200);
    const sessions = await sessionsOf(account.userId);
    expect(sessions.filter((session) => session['revoked_at'] === null)).toHaveLength(20);
    expect(sessions.filter((session) => session['revoked_at'] !== null)).toEqual([
      expect.objectContaining({ id: pairs[1]?.session_id, revoked_reason: 'session_limit' }),
    ]);
    const [tokens] = await ctx.worker.sql<{ count: string }[]>`
      select count(*) from session_tokens where session_id = ${pairs[1]?.session_id ?? ''}`;
    expect(tokens?.count).toBe('0');
    expect(await eventsOf(account.userId, 'session_revoked')).toEqual([
      expect.objectContaining({ session_id: pairs[1]?.session_id, metadata: { reason: 'session_limit' } }),
    ]);
  });

  it.each([
    ['no client', { client: undefined }, '/client'],
    ['an unknown client', { client: 'web' }, '/client'],
    ['an empty device label', { device_label: '' }, '/device_label'],
    ['a device label of 65 characters', { device_label: 'x'.repeat(65) }, '/device_label'],
    ['an unknown property', { remember_me: true }, ''],
  ])('refuses %s with 400', async (_name, change, pointer) => {
    const account = await ctx.account();

    const response = await login(account, change);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ errors: [{ pointer }] });
  });

  it('accepts a device label of 64 emoji (64 characters, 128 UTF-16 code units)', async () => {
    const account = await ctx.account();

    expect((await login(account, { device_label: '📱'.repeat(64) })).statusCode).toBe(200);
  });

  it('never writes an address, a password, a device label or a token to the log [R-LOG-02]', async () => {
    const tokens = await ctx.worker.sql<{ count: string }[]>`select count(*) from session_tokens`;

    expect(Number(tokens[0]?.count)).toBeGreaterThan(20);
    for (const secret of ['@example.test', 'purple elephants', 'iPhone', 'ql_at_', 'ql_rt_', 'ql_vt_']) {
      expect(logs.text).not.toContain(secret);
    }
  });
});
