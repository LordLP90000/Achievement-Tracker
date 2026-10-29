import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAccountsApp, type AccountsApp } from '../helpers/accounts-app.ts';
import { contractInject } from '../helpers/contract.ts';

interface TokenPair {
  readonly access_token: string;
  readonly refresh_token: string;
}

const bearer = (pair: TokenPair) => ({ authorization: `Bearer ${pair.access_token}` });

/** What a stolen database dump or backup shows (R-ENC-01, R-ENC-02): ciphertext, hashes and blind indexes only. */
describe('encryption at rest [I-01, T-05]', () => {
  let ctx: AccountsApp;

  beforeAll(async () => {
    ctx = await startAccountsApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  const login = async (email: string, password: string, deviceLabel: string): Promise<TokenPair> => {
    const response = await ctx.post('/v1/auth/login', {
      email,
      password,
      client: 'android',
      device_label: deviceLabel,
    });
    expect(response.statusCode).toBe(200);
    return response.json<TokenPair>();
  };

  /** Every value of every table, read as the superuser: text and JSON values as text, `bytea` values as bytes. */
  async function dump(): Promise<{ readonly text: string; readonly blobs: readonly Buffer[] }> {
    const tables = await ctx.admin.sql<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'`;
    const parts: string[] = [];
    const blobs: Buffer[] = [];
    for (const { table_name: table } of tables) {
      for (const row of await ctx.admin.sql`select * from ${ctx.admin.sql(table)}`) {
        for (const value of Object.values(row)) {
          if (Buffer.isBuffer(value)) blobs.push(value);
          else parts.push(JSON.stringify(value));
        }
      }
    }
    return { text: parts.join('\n').toLowerCase(), blobs };
  }

  it('leaves no address, nickname, device label, password or token readable in any table [I-01]', async () => {
    const account = await ctx.account();
    const deviceLabel = 'Ada Lovelace phone';
    const nickname = 'Countess of Lovelace';
    const pair = await login(account.email, account.password, deviceLabel);
    const current = await contractInject(ctx.app, { method: 'GET', url: '/v1/me', headers: bearer(pair) });
    const patched = await contractInject(ctx.app, {
      method: 'PATCH',
      url: '/v1/me',
      headers: { ...bearer(pair), 'content-type': 'application/json', 'if-match': String(current.headers.etag) },
      payload: JSON.stringify({ nickname }),
    });
    expect(patched.statusCode).toBe(200);
    const newAddress = `ada-next-${randomUUID().slice(0, 8)}@example.test`;
    expect((await ctx.post('/v1/me/email-change', { new_email: newAddress }, bearer(pair))).statusCode).toBe(202);
    expect((await ctx.post('/v1/auth/password/forgot', { email: account.email })).statusCode).toBe(202);
    const tokens = (await ctx.emails()).flatMap((email) =>
      email.payload.token === undefined ? [] : [email.payload.token],
    );
    expect(tokens.length).toBeGreaterThanOrEqual(3);
    const secrets = [
      account.email,
      newAddress,
      deviceLabel,
      nickname,
      account.password,
      pair.access_token,
      pair.refresh_token,
      ...tokens,
    ];

    const { text, blobs } = await dump();

    expect(blobs.length).toBeGreaterThan(10);
    for (const secret of secrets) {
      expect(text).not.toContain(secret.toLowerCase());
      expect(blobs.some((blob) => blob.includes(Buffer.from(secret, 'utf8')))).toBe(false);
    }
  });

  it('fails closed when encrypted addresses are swapped between two accounts [T-05]', async () => {
    const first = await ctx.account();
    const second = await ctx.account();
    const pairs = [
      await login(first.email, first.password, 'first phone'),
      await login(second.email, second.password, 'second phone'),
    ];
    await ctx.admin.sql`
      update users set email_enc = case id
        when ${first.userId} then (select email_enc from users where id = ${second.userId})
        else (select email_enc from users where id = ${first.userId}) end
      where id in (${first.userId}, ${second.userId})`;

    for (const pair of pairs) {
      // 500 is undocumented in the contract (a server fault), so this request bypasses the contract hook.
      const response = await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: bearer(pair) });
      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('@example.test');
    }
  });
});
