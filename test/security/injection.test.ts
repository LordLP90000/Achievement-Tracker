import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAccountsApp, type AccountsApp } from '../helpers/accounts-app.ts';
import { contractInject } from '../helpers/contract.ts';

/** SQL meta-characters in user input (33 characters: within every field's length limit). */
const META = `'); DROP TABLE users;-- "\\ %_$1:n`;

interface TokenPair {
  readonly access_token: string;
}

/**
 * Every query is parameterized (ADR-0003; ESLint bans string-built SQL): meta-characters in any field are data and
 * come back unchanged (T-03, R-IN-02). M3 extends this to the goal-content fields.
 */
describe('SQL meta-characters [T-03, R-IN-02]', () => {
  let ctx: AccountsApp;

  beforeAll(async () => {
    ctx = await startAccountsApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('keeps them as data in the address, the password, the device label and the nickname', async () => {
    const email = `o'hara-${randomUUID().slice(0, 8)}@example.test`;
    const password = `pass'word"; DROP TABLE sessions; --`;
    const registered = await ctx.post('/v1/auth/register', {
      email,
      password,
      privacy_policy_version: '2026-10-01',
      age_confirmed: true,
    });
    expect(registered.statusCode).toBe(202);
    const token = (await ctx.emails()).find((queued) => queued.payload.to === email)?.payload.token ?? '';
    expect((await ctx.post('/v1/auth/verify-email', { token })).statusCode).toBe(204);
    const login = await ctx.post('/v1/auth/login', { email, password, client: 'ios', device_label: META });
    expect(login.statusCode).toBe(200);
    const headers = { authorization: `Bearer ${login.json<TokenPair>().access_token}` };

    const current = await contractInject(ctx.app, { method: 'GET', url: '/v1/me', headers });
    const patched = await contractInject(ctx.app, {
      method: 'PATCH',
      url: '/v1/me',
      headers: { ...headers, 'content-type': 'application/json', 'if-match': String(current.headers.etag) },
      payload: JSON.stringify({ nickname: META }),
    });
    const sessions = await contractInject(ctx.app, { method: 'GET', url: '/v1/me/sessions', headers });

    expect(patched.json()).toMatchObject({ email, nickname: META });
    expect(sessions.json<{ items: { device_label: string | null }[] }>().items).toEqual([
      expect.objectContaining({ device_label: META }),
    ]);
    const tables = await ctx.admin.sql<{ count: number }[]>`
      select count(*)::int as count from information_schema.tables
      where table_schema = 'public' and table_name in ('users', 'sessions')`;
    expect(tables[0]?.count).toBe(2);
  });
});
