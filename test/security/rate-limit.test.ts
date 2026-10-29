import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAccountsApp, type AccountsApp, type TestAccount } from '../helpers/accounts-app.ts';
import { contractInject } from '../helpers/contract.ts';
import { LogCapture } from '../helpers/log-capture.ts';

interface TokenPair {
  access_token: string;
}

/** A syntactically valid but unknown verification token: a cheap public request that is always 401. */
const unknownToken = () => `ql_vt_${randomUUID().replaceAll('-', '').padEnd(43, 'A')}`;

describe('rate limits [R-AUTH-08, ADR-0009, S-01, D-04, D-05, I-19, A-31]', () => {
  let ctx: AccountsApp;
  const logs = new LogCapture();
  let network = 0;
  /** A fresh client address per test, so tests never share a per-IP bucket by accident. */
  const nextIp = () => {
    network += 1;
    return `203.0.${String(network)}.7`;
  };

  const post = (url: string, body: unknown, ip: string, headers: Record<string, string> = {}) =>
    ctx.post(url, body, headers, ip);
  const verify = (ip: string) => post('/v1/auth/verify-email', { token: unknownToken() }, ip);
  const login = (email: string, password: string, ip: string) =>
    post('/v1/auth/login', { email, password, client: 'ios' }, ip);
  const statuses = async (count: number, request: () => Promise<{ statusCode: number }>) => {
    const codes = [];
    for (let attempt = 0; attempt < count; attempt += 1) codes.push((await request()).statusCode);
    return codes;
  };
  const session = async (account: TestAccount): Promise<TokenPair> =>
    (await login(account.email, account.password, nextIp())).json();

  beforeAll(async () => {
    ctx = await startAccountsApp({ logCapture: logs, rateLimits: 'enforced' });
  });

  afterAll(async () => {
    await ctx.close();
  });

  describe('per client network on public endpoints', () => {
    it('allows 20 requests a minute from one address, then answers 429 with Retry-After until a token is back', async () => {
      const ip = nextIp();

      expect(await statuses(20, () => verify(ip))).toEqual(Array<number>(20).fill(401));
      const refused = await verify(ip);

      expect(refused.statusCode).toBe(429);
      expect(refused.headers['retry-after']).toBe('3');
      expect(refused.json()).toMatchObject({ type: 'urn:questline:problem:rate-limited', status: 429 });
      expect((await verify(nextIp())).statusCode).toBe(401);
      ctx.clock.advance({ seconds: 3 });
      expect((await verify(ip)).statusCode).toBe(401);
    });

    it('counts an IPv6 /64 as one client, whatever address of it is used', async () => {
      await statuses(20, () => verify('2001:db8:aa:1::1'));

      expect((await verify('2001:db8:aa:1:ffff:ffff:ffff:ffff')).statusCode).toBe(429);
      expect((await verify('2001:db8:aa:2::1')).statusCode).toBe(401);
    });

    it('shares the buckets between API instances on one database [ADR-0009]', async () => {
      const second = await ctx.createInstance();
      const ip = nextIp();
      const verifyOn = (index: number) =>
        contractInject(index % 2 === 0 ? ctx.app : second, {
          method: 'POST',
          url: '/v1/auth/verify-email',
          headers: { 'content-type': 'application/json' },
          payload: JSON.stringify({ token: unknownToken() }),
          remoteAddress: ip,
        });

      const codes = [];
      for (let index = 0; index < 21; index += 1) codes.push((await verifyOn(index)).statusCode);

      expect(codes.slice(0, 20)).toEqual(Array<number>(20).fill(401));
      expect(codes[20]).toBe(429);
    });
  });

  describe('progressive backoff on wrong passwords [S-01, D-04]', () => {
    it('blocks an address after 5 wrong passwords, even for the right one, and lifts the block in time', async () => {
      const account = await ctx.account();
      const wrong = () => login(account.email, 'not the right passphrase', nextIp());

      expect(await statuses(6, wrong)).toEqual([401, 401, 401, 401, 401, 401]);
      const blocked = await login(account.email, account.password, nextIp());

      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['retry-after']).toBe('60');
      ctx.clock.advance({ seconds: 60 });
      expect((await login(account.email, account.password, nextIp())).statusCode).toBe(200);
      // The success cleared the failures: five more are free again.
      expect(await statuses(5, wrong)).toEqual([401, 401, 401, 401, 401]);
    });

    it('doubles the block with every further failure, up to 15 minutes', async () => {
      const account = await ctx.account();
      const waits = [];
      for (let attempt = 0; attempt < 17; attempt += 1) {
        const response = await login(account.email, 'not the right passphrase', nextIp());
        if (response.statusCode === 429) {
          const seconds = Number(response.headers['retry-after']);
          waits.push(seconds);
          ctx.clock.advance({ seconds });
        }
      }

      expect(waits).toEqual([60, 120, 240, 480, 900, 900]);
    });

    it('treats an unknown address exactly like a registered one (no enumeration) [R-AUTH-07]', async () => {
      const unknown = `nobody-${randomUUID().slice(0, 8)}@example.test`;

      expect(await statuses(6, () => login(unknown, 'not the right passphrase', nextIp()))).toEqual(
        Array<number>(6).fill(401),
      );
      const blocked = await login(unknown, 'not the right passphrase', nextIp());
      expect(blocked.statusCode).toBe(429);
      expect(blocked.headers['retry-after']).toBe('60');
    });

    it('blocks re-authentication and password change of a user after 5 wrong passwords', async () => {
      const account = await ctx.account();
      const pair = await session(account);
      const bearer = { authorization: `Bearer ${pair.access_token}` };
      const reauth = (password: string) => post('/v1/auth/reauth', { password }, nextIp(), bearer);

      expect(await statuses(3, () => reauth('not the right passphrase'))).toEqual([401, 401, 401]);
      const change = () =>
        post(
          '/v1/me/password',
          { current_password: 'not the right passphrase', new_password: 'seven silver swans swimming' },
          nextIp(),
          bearer,
        );
      expect(await statuses(3, change)).toEqual([401, 401, 401]);

      expect((await reauth(account.password)).statusCode).toBe(429);
    });
  });

  describe('per address and per user on requests that send email [D-05, A-25]', () => {
    it('sends at most 3 emails an hour to one address, registered or not, and refuses the 4th request', async () => {
      const account = await ctx.account({ verified: false });
      const resend = (email: string) => post('/v1/auth/resend-verification', { email }, nextIp());
      const unknown = `nobody-${randomUUID().slice(0, 8)}@example.test`;

      expect(await statuses(2, () => resend(account.email))).toEqual([202, 202]);
      expect((await resend(account.email)).statusCode).toBe(429);
      expect(await statuses(3, () => post('/v1/auth/password/forgot', { email: unknown }, nextIp()))).toEqual([
        202, 202, 202,
      ]);
      const refused = await post('/v1/auth/password/forgot', { email: unknown }, nextIp());
      expect(refused.statusCode).toBe(429);
      expect(refused.headers['retry-after']).toBe('1200');
    });

    it('does not count a registration refused for a breached password', async () => {
      const email = `user-${randomUUID().slice(0, 8)}@example.test`;
      const register = (password: string) =>
        post(
          '/v1/auth/register',
          { email, password, privacy_policy_version: '2026-10-01', age_confirmed: true },
          nextIp(),
        );

      expect(await statuses(4, () => register('password1234'))).toEqual([422, 422, 422, 422]);
      expect(await statuses(3, () => register('a perfectly fine passphrase'))).toEqual([202, 202, 202]);
      expect((await register('a perfectly fine passphrase')).statusCode).toBe(429);
    });

    it('allows a user 3 email-change requests an hour', async () => {
      const pair = await session(await ctx.account());
      const request = () =>
        post('/v1/me/email-change', { new_email: `new-${randomUUID().slice(0, 8)}@example.test` }, nextIp(), {
          authorization: `Bearer ${pair.access_token}`,
        });

      expect(await statuses(4, request)).toEqual([202, 202, 202, 429]);
    });

    it('starts afresh each UTC day: the daily key makes yesterday’s buckets unreachable [Q-14, I-19]', async () => {
      ctx.clock.set('2026-11-02T23:58:00Z');
      const email = `nobody-${randomUUID().slice(0, 8)}@example.test`;
      const forgot = () => post('/v1/auth/password/forgot', { email }, nextIp());
      await statuses(3, forgot);
      expect((await forgot()).statusCode).toBe(429);

      ctx.clock.set('2026-11-03T00:01:00Z');

      expect((await forgot()).statusCode).toBe(202);
    });
  });

  describe('per user on every authenticated operation [Q-30]', () => {
    it('allows a user 120 requests a minute, e.g. GET /me, then answers 429 until a token is back; others are unaffected', async () => {
      const [first, second] = [await session(await ctx.account()), await session(await ctx.account())];
      const me = (pair: TokenPair) =>
        contractInject(ctx.app, {
          method: 'GET',
          url: '/v1/me',
          headers: { authorization: `Bearer ${pair.access_token}` },
        });

      expect(await statuses(120, () => me(first))).toEqual(Array<number>(120).fill(200));
      const refused = await me(first);

      expect(refused.statusCode).toBe(429);
      expect(refused.headers['retry-after']).toBe('1');
      expect(refused.json()).toMatchObject({ type: 'urn:questline:problem:rate-limited', status: 429 });
      expect((await me(second)).statusCode).toBe(200);
      ctx.clock.advance({ seconds: 1 });
      expect((await me(first)).statusCode).toBe(200);
    });
  });

  it('keeps only keyed hashes and counters: no address, no email in the table or the log [Q-14, I-19, R-LOG-02]', async () => {
    const columns = await ctx.worker.sql<{ column_name: string; data_type: string }[]>`
      select column_name, data_type from information_schema.columns where table_name = 'rate_limit_buckets'
      order by column_name`;
    const keys = await ctx.worker.sql<{ length: number }[]>`
      select distinct octet_length(bucket_key) as length from rate_limit_buckets`;

    expect(columns.map((column) => ({ ...column }))).toEqual([
      { column_name: 'blocked_until', data_type: 'timestamp with time zone' },
      { column_name: 'bucket_key', data_type: 'bytea' },
      { column_name: 'failures', data_type: 'integer' },
      { column_name: 'tokens', data_type: 'double precision' },
      { column_name: 'updated_at', data_type: 'timestamp with time zone' },
    ]);
    expect(keys.map((row) => row.length)).toEqual([32]);
    expect(logs.records().filter((record) => record['msg'] === 'rate limited').length).toBeGreaterThan(5);
    for (const secret of ['203.0.', '2001:db8', '@example.test']) expect(logs.text).not.toContain(secret);
  });
});
