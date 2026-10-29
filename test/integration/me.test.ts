import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAccountsApp, type AccountsApp, type TestAccount } from '../helpers/accounts-app.ts';
import { contractInject } from '../helpers/contract.ts';
import { LogCapture } from '../helpers/log-capture.ts';

interface TokenPair {
  access_token: string;
}

describe('GET and PATCH /v1/me [R-PRIV-01, R-AUTHZ-04, ADR-0008, A-01]', () => {
  let ctx: AccountsApp;
  const logs = new LogCapture();

  const session = async (account: TestAccount): Promise<TokenPair> =>
    (await ctx.post('/v1/auth/login', { email: account.email, password: account.password, client: 'ios' })).json();
  const getMe = (pair: TokenPair) =>
    contractInject(ctx.app, {
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${pair.access_token}` },
    });
  const patchMe = (pair: TokenPair, body: unknown, ifMatch?: string) =>
    contractInject(ctx.app, {
      method: 'PATCH',
      url: '/v1/me',
      headers: {
        authorization: `Bearer ${pair.access_token}`,
        'content-type': 'application/json',
        ...(ifMatch === undefined ? {} : { 'if-match': ifMatch }),
      },
      payload: JSON.stringify(body),
    });
  const userRow = async (userId: string) =>
    (await ctx.worker.sql<Record<string, unknown>[]>`select * from users where id = ${userId}`)[0];

  beforeAll(async () => {
    ctx = await startAccountsApp({ logCapture: logs });
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('returns the account with its decrypted address and an ETag of its version', async () => {
    const account = await ctx.account();

    const response = await getMe(await session(account));

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe('"2"');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({
      id: account.userId,
      email: account.email,
      nickname: null,
      timezone: 'Europe/Zurich',
      locale: 'de-CH',
      week_start: 'monday',
      email_verified: true,
      created_at: '2026-10-29T12:00:00.000Z',
      xp_total: 0,
      level: 1,
      version: 2,
    });
  });

  it('updates the settings and the nickname, which is stored only encrypted, and bumps the version', async () => {
    const account = await ctx.account();
    const pair = await session(account);

    const response = await patchMe(
      pair,
      { nickname: 'Anna 🐉', timezone: 'america/new_york', locale: 'fr-CH', week_start: 'sunday' },
      '"2"',
    );

    expect(response.statusCode).toBe(200);
    expect(response.headers.etag).toBe('"3"');
    expect(response.json()).toMatchObject({
      nickname: 'Anna 🐉',
      timezone: 'America/New_York',
      locale: 'fr-CH',
      week_start: 'sunday',
      version: 3,
    });
    const row = await userRow(account.userId);
    expect(row).toMatchObject({ timezone: 'America/New_York', locale: 'fr-CH', week_start: 'sunday', version: 3 });
    expect((row?.['nickname_enc'] as Buffer).includes(Buffer.from('Anna'))).toBe(false);
    expect((await getMe(pair)).json()).toMatchObject({ nickname: 'Anna 🐉', version: 3 });
  });

  it('removes the nickname with null and leaves everything else as it was', async () => {
    const account = await ctx.account();
    const pair = await session(account);
    await patchMe(pair, { nickname: 'Temporary' }, '"2"');

    const response = await patchMe(pair, { nickname: null }, '"3"');

    expect(response.json()).toMatchObject({ nickname: null, timezone: 'Europe/Zurich', version: 4 });
    expect(await userRow(account.userId)).toMatchObject({ nickname_enc: null });
  });

  it('requires If-Match: 428 without it, nothing changed', async () => {
    const account = await ctx.account();

    const response = await patchMe(await session(account), { week_start: 'saturday' });

    expect(response.statusCode).toBe(428);
    expect(response.json()).toMatchObject({ type: 'urn:questline:problem:precondition-required' });
    expect(await userRow(account.userId)).toMatchObject({ week_start: 'monday', version: 2 });
  });

  it('refuses a stale version with 409 and the current version, nothing changed', async () => {
    const account = await ctx.account();

    const response = await patchMe(await session(account), { week_start: 'saturday' }, '"1"');

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ type: 'urn:questline:problem:version-conflict', current_version: 2 });
    expect(await userRow(account.userId)).toMatchObject({ week_start: 'monday', version: 2 });
  });

  it.each([
    ['a malformed If-Match', { week_start: 'saturday' }, 'W/"2"', ''],
    ['an empty update', {}, '"2"', ''],
    ['the email (changed only by the email-change flow)', { email: 'other@example.test' }, '"2"', ''],
    ['the version', { version: 7 }, '"2"', ''],
    ['an unknown week start', { week_start: 'friday' }, '"2"', '/week_start'],
    ['an unsupported time zone', { timezone: '+01:00' }, '"2"', '/timezone'],
    ['a nickname of 41 characters', { nickname: 'x'.repeat(41) }, '"2"', '/nickname'],
    ['an empty nickname', { nickname: '' }, '"2"', '/nickname'],
  ])('refuses %s with 400 [R-AUTHZ-04]', async (_name, body, ifMatch, pointer) => {
    const account = await ctx.account();

    const response = await patchMe(await session(account), body, ifMatch);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ errors: [{ pointer }] });
    expect(await userRow(account.userId)).toMatchObject({ version: 2 });
  });

  it('accepts a nickname of 40 emoji (40 characters)', async () => {
    const account = await ctx.account();

    expect((await patchMe(await session(account), { nickname: '🐉'.repeat(40) }, '"2"')).statusCode).toBe(200);
  });

  it('never writes an address or a nickname to the log [R-LOG-02]', () => {
    for (const secret of ['@example.test', 'Anna', 'Temporary', '🐉']) expect(logs.text).not.toContain(secret);
  });
});
