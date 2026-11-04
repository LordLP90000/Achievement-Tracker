import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deletePasskey } from '../../src/modules/sign-in-methods/repository.ts';
import { createDatabase, inTransaction } from '../../src/platform/db/database.ts';
import { startAccountsApp, type AccountsApp, type TestAccount } from '../helpers/accounts-app.ts';
import { contractInject } from '../helpers/contract.ts';
import { bearer } from '../helpers/goals.ts';
import { register, type CreationOptions } from '../helpers/software-authenticator.ts';

const ORIGIN = 'https://questline.test';
const MINUTE = 60_000;

interface Passkey {
  readonly id: string;
  readonly name: string | null;
  readonly created_at: string;
  readonly last_used_at: string | null;
  readonly backed_up: boolean;
}

interface Options extends CreationOptions {
  readonly user: { readonly id: string; readonly name: string; readonly displayName: string };
  readonly excludeCredentials: { readonly id: string }[];
}

/** Registering, listing and removing passkeys (ADR-0019, R-AUTH-01, R-AUTH-06, R-LOG-03). */
describe('passkeys of the account', () => {
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
    ctx.clock.set('2026-11-04T12:00:00Z');
    account = await ctx.account();
    token = await login(account);
  });

  async function login(who: TestAccount): Promise<string> {
    const response = await ctx.post('/v1/auth/login', { email: who.email, password: who.password, client: 'ios' });
    expect(response.statusCode).toBe(200);
    return response.json<{ access_token: string }>().access_token;
  }

  const call = (method: 'GET' | 'POST' | 'DELETE', url: string, body?: unknown, as = token) =>
    contractInject(ctx.app, {
      method,
      url,
      headers: { ...bearer(as), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
    });
  const options = async (as = token): Promise<Options> => {
    const response = await call('POST', '/v1/me/passkeys/options', undefined, as);
    expect(response.statusCode).toBe(200);
    return response.json<Options>();
  };
  const add = async (name?: string, as = token) => {
    const { credential, passkey } = register(await options(as), { origin: ORIGIN });
    const response = await call('POST', '/v1/me/passkeys', { credential, ...(name === undefined ? {} : { name }) }, as);
    return { response, passkey };
  };
  const problemOf = (response: { statusCode: number; json: () => unknown }) => ({
    status: response.statusCode,
    type: (response.json() as { type: string }).type,
  });
  const stored = async () =>
    (
      await ctx.admin.sql<
        {
          id: string;
          credential_id: Buffer;
          public_key: Buffer;
          sign_count: string;
          transports: string[];
          name_enc: Buffer | null;
        }[]
      >`select id, credential_id, public_key, sign_count, transports, name_enc from passkeys
        where user_id = ${account.userId} order by created_at`
    ).map((row) => ({ ...row }));
  const events = async (type: string) =>
    (
      await ctx.admin.sql<{ outcome: string; session_id: string | null; metadata: Record<string, string> }[]>`
        select outcome, session_id, metadata from audit_events where user_id = ${account.userId} and event_type = ${type}`
    ).map((row) => ({ ...row }));
  const notices = async () =>
    (await ctx.emails()).filter(
      (email) => email.userId === account.userId && email.template === 'sign_in_methods_changed_notice',
    );
  const insertPasskeys = async (count: number) => {
    for (let index = 0; index < count; index += 1) {
      await ctx.admin.sql`
        insert into passkeys (id, user_id, credential_id, public_key, sign_count, transports, backed_up, created_at)
        values (${randomUUID()}, ${account.userId}, ${Buffer.from(randomUUID())}, ${Buffer.from('key')}, 0, '{}', true,
                ${ctx.clock.now()})`;
    }
  };

  describe('creation options', () => {
    it('bind a fresh challenge to the account, name it by its address and ID, and exclude its passkeys', async () => {
      const { passkey } = await add();

      const created = await options();

      expect(created.user).toEqual({
        id: Buffer.from(account.userId.replaceAll('-', ''), 'hex').toString('base64url'),
        name: account.email,
        displayName: account.email,
      });
      expect(created.excludeCredentials.map((excluded) => excluded.id)).toEqual([
        passkey.credentialId.toString('base64url'),
      ]);
      const [challenge] = await ctx.admin.sql<{ purpose: string; user_id: string; challenge_hash: Buffer }[]>`
        select purpose, user_id, challenge_hash from webauthn_challenges where user_id = ${account.userId}`;
      expect(challenge).toMatchObject({ purpose: 'registration', user_id: account.userId });
      expect(challenge?.challenge_hash.toString('base64url')).not.toBe(created.challenge);
    });

    it('refuse an eleventh passkey before anything is created', async () => {
      await insertPasskeys(10);

      expect(problemOf(await call('POST', '/v1/me/passkeys/options'))).toEqual({
        status: 422,
        type: 'urn:questline:problem:limit-reached',
      });
    });
  });

  describe('registration', () => {
    it('stores a verified passkey with its encrypted name, audits it and tells the owner', async () => {
      const { response, passkey } = await add('iPhone');

      expect(response.statusCode).toBe(201);
      const created = response.json<Passkey>();
      expect(created).toEqual({
        id: expect.any(String) as unknown,
        name: 'iPhone',
        created_at: ctx.clock.now().toISOString(),
        last_used_at: null,
        backed_up: true,
      });
      const [row] = await stored();
      expect(row).toMatchObject({
        id: created.id,
        credential_id: passkey.credentialId,
        public_key: passkey.publicKey,
        sign_count: '1',
        transports: ['internal', 'hybrid'],
      });
      expect(row?.name_enc?.toString('latin1')).not.toContain('iPhone');
      expect(await events('passkey_added')).toEqual([
        { outcome: 'success', session_id: expect.any(String) as unknown, metadata: { passkey_id: created.id } },
      ]);
      expect(await notices()).toHaveLength(1);
      expect(await ctx.admin.sql`select 1 from webauthn_challenges where user_id = ${account.userId}`).toHaveLength(0);
    });

    it('uses each challenge once', async () => {
      const created = await options();
      const first = register(created, { origin: ORIGIN });
      const second = register(created, { origin: ORIGIN });

      expect((await call('POST', '/v1/me/passkeys', { credential: first.credential })).statusCode).toBe(201);
      expect(problemOf(await call('POST', '/v1/me/passkeys', { credential: second.credential }))).toEqual({
        status: 422,
        type: 'urn:questline:problem:invalid-passkey',
      });
    });

    it.each([
      ['a challenge older than 5 minutes', 5 * MINUTE, {}],
      ['another origin', 0, { origin: 'https://evil.test' }],
      ['no user verification', 0, { userVerified: false }],
    ])('refuses a result with %s', async (_label, delay, settings) => {
      const created = await options();
      const { credential } = register(created, { origin: ORIGIN, ...settings });
      ctx.clock.advance({ milliseconds: delay });

      expect(problemOf(await call('POST', '/v1/me/passkeys', { credential }))).toEqual({
        status: 422,
        type: 'urn:questline:problem:invalid-passkey',
      });
      expect(await stored()).toEqual([]);
    });

    it("refuses a result for another account's challenge, and leaves that challenge alone", async () => {
      const other = await ctx.account();
      const otherToken = await login(other);
      const othersOptions = await options(otherToken);
      const { credential } = register(othersOptions, { origin: ORIGIN });

      expect(problemOf(await call('POST', '/v1/me/passkeys', { credential }))).toEqual({
        status: 422,
        type: 'urn:questline:problem:invalid-passkey',
      });
      expect((await call('POST', '/v1/me/passkeys', { credential }, otherToken)).statusCode).toBe(201);
    });

    it('refuses a passkey registered already, by this account or another', async () => {
      const { passkey } = await add();
      const other = await ctx.account();
      const otherToken = await login(other);

      for (const as of [token, otherToken]) {
        const { credential } = register(await options(as), { origin: ORIGIN, credentialId: passkey.credentialId });
        expect(problemOf(await call('POST', '/v1/me/passkeys', { credential }, as))).toEqual({
          status: 422,
          type: 'urn:questline:problem:invalid-passkey',
        });
      }
      expect(await stored()).toHaveLength(1);
    });

    it('refuses the eleventh passkey even with options from before the tenth', async () => {
      await insertPasskeys(9);
      const early = await options();
      expect((await add()).response.statusCode).toBe(201);

      const { credential } = register(early, { origin: ORIGIN });

      expect(problemOf(await call('POST', '/v1/me/passkeys', { credential }))).toEqual({
        status: 422,
        type: 'urn:questline:problem:limit-reached',
      });
    });
  });

  describe('list', () => {
    it("shows the account's passkeys, newest first, names decrypted, and nobody else's", async () => {
      await add('First');
      ctx.clock.advance({ milliseconds: 1000 });
      await add();
      const other = await ctx.account();
      await add('Not mine', await login(other));

      const response = await call('GET', '/v1/me/passkeys');

      expect(response.statusCode).toBe(200);
      expect(response.json<{ items: Passkey[] }>().items.map((item) => item.name)).toEqual([null, 'First']);
    });
  });

  describe('removal', () => {
    it("removes only the account's own passkey by its own condition, where no policy restricts it", async () => {
      const other = await ctx.account();
      const { response } = await add('Theirs', await login(other));
      const { id } = response.json<Passkey>();

      const removed = await inTransaction(createDatabase(ctx.admin), (tx) => deletePasskey(tx, account.userId, id));

      expect(removed).toBe(false);
      expect(await ctx.admin.sql`select 1 from passkeys where id = ${id}`).toHaveLength(1);
    });

    it('deletes the passkey, audits it and tells the owner', async () => {
      const { response } = await add('Old phone');
      const { id } = response.json<Passkey>();

      expect((await call('DELETE', `/v1/me/passkeys/${id}`)).statusCode).toBe(204);
      expect(await stored()).toEqual([]);
      expect(await events('passkey_removed')).toEqual([
        { outcome: 'success', session_id: expect.any(String) as unknown, metadata: { passkey_id: id } },
      ]);
      expect(await notices()).toHaveLength(2);
      expect((await call('DELETE', `/v1/me/passkeys/${id}`)).statusCode).toBe(404);
    });
  });

  it.each([
    ['ask for options', 'POST', '/v1/me/passkeys/options'],
    ['register', 'POST', '/v1/me/passkeys'],
    ['remove', 'DELETE', `/v1/me/passkeys/${randomUUID()}`],
  ] as const)('requires the password within 10 minutes to %s [R-AUTH-06]', async (_label, method, url) => {
    const body =
      method === 'POST' && url.endsWith('passkeys')
        ? { credential: register(await options(), { origin: ORIGIN }).credential }
        : undefined;
    ctx.clock.advance({ milliseconds: 10 * MINUTE });

    expect(problemOf(await call(method, url, body))).toEqual({
      status: 403,
      type: 'urn:questline:problem:reauthentication-required',
    });
  });

  it('lists without a recent password', async () => {
    ctx.clock.advance({ milliseconds: 10 * MINUTE });

    expect((await call('GET', '/v1/me/passkeys')).statusCode).toBe(200);
  });
});
