import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startAccountsApp, TEST_PASSWORD, type AccountsApp, type TestAccount } from '../helpers/accounts-app.ts';
import { contractInject } from '../helpers/contract.ts';
import { bearer } from '../helpers/goals.ts';
import { specOperations, type SpecOperation } from '../helpers/openapi.ts';

interface TokenPair {
  readonly access_token: string;
  readonly refresh_token: string;
}

interface DeletedAccount extends TestAccount {
  readonly tokens: TokenPair;
}

const authenticated = specOperations.filter((operation) => operation.requiresAuth);

/**
 * E-13: an account pending deletion (R-PRIV-06) is of no use to whoever holds its former tokens, gets no email but
 * the deletion notice and a reset link it asks for, and gives itself away to no one (A-22, Q-46, Q-48, R-AUTH-07);
 * only a password login or a password reset brings it back — rate-limited and audited. Real rate limits throughout,
 * each request from its own client network.
 */
describe('an account pending deletion [E-13, A-22, Q-46, Q-48, R-PRIV-06]', () => {
  let ctx: AccountsApp;
  let network = 0;
  const nextIp = () => {
    network += 1;
    return `203.0.${String(network)}.9`;
  };

  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    ctx.post(url, body, headers, nextIp());
  const login = (email: string, password: string) => post('/v1/auth/login', { email, password, client: 'ios' });
  /** A verified account that logged in on one device and then asked for its deletion. */
  const deletedAccount = async (): Promise<DeletedAccount> => {
    const account = await ctx.account();
    const tokens = (await login(account.email, account.password)).json<TokenPair>();
    const deleted = await contractInject(ctx.app, {
      method: 'DELETE',
      url: '/v1/me',
      headers: bearer(tokens.access_token),
      remoteAddress: nextIp(),
    });
    if (deleted.statusCode !== 202) throw new Error(`deletion failed: ${String(deleted.statusCode)}`);
    return { ...account, tokens };
  };
  const call = (operation: SpecOperation, token: string) =>
    contractInject(ctx.app, {
      method: operation.method as 'GET',
      url: operation.path.replace(/\{[^}]+\}/g, randomUUID()),
      headers: { ...bearer(token), ...(operation.hasRequestBody ? { 'content-type': 'application/json' } : {}) },
      ...(operation.hasRequestBody ? { payload: '{}' } : {}),
      remoteAddress: nextIp(),
    });
  const answerOf = (response: { statusCode: number; json: () => unknown }) => ({
    status: response.statusCode,
    body: { ...(response.json() as Record<string, unknown>), request_id: undefined },
  });
  const emailsTo = async (address: string) =>
    (await ctx.emails()).filter((email) => email.payload.to === address).map((email) => email.template);
  const isDeactivated = async (userId: string) =>
    (
      await ctx.admin.sql<{ deactivated: boolean }[]>`
      select deactivated_at is not null as deactivated from users where id = ${userId}`
    )[0]?.deactivated;

  beforeAll(async () => {
    ctx = await startAccountsApp({ rateLimits: 'enforced' });
    ctx.clock.set('2026-10-29T12:00:00Z');
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('accepts none of its former tokens: every authenticated operation of the contract → 401, and so does a refresh', async () => {
    const account = await deletedAccount();

    const answers: Record<string, number> = {};
    for (const operation of authenticated) {
      answers[operation.operationId] = (await call(operation, account.tokens.access_token)).statusCode;
    }
    const refreshed = await post('/v1/auth/refresh', { refresh_token: account.tokens.refresh_token });

    expect(answers).toEqual(Object.fromEntries(authenticated.map((operation) => [operation.operationId, 401])));
    expect(refreshed.statusCode).toBe(401);
  });

  it('stays hidden: registration, resend and forgot-password answer as for an unknown address, and only the reset link is sent [A-22, R-AUTH-07, Q-48]', async () => {
    const account = await deletedAccount();
    // The account's own registration used one of the address's 3 emails an hour (A-25): all are back after an hour.
    ctx.clock.advance({ hours: 1 });
    const queued = await emailsTo(account.email);
    const unknown = `nobody-${randomUUID().slice(0, 8)}@example.test`;
    const requests = [
      (email: string) =>
        post('/v1/auth/register', {
          email,
          password: TEST_PASSWORD,
          privacy_policy_version: '2026-10-01',
          age_confirmed: true,
        }),
      (email: string) => post('/v1/auth/resend-verification', { email }),
      (email: string) => post('/v1/auth/password/forgot', { email }),
    ];

    for (const request of requests) {
      const [mine, theirs] = [await request(account.email), await request(unknown)];
      expect(answerOf(mine)).toEqual(answerOf(theirs));
      expect(mine.statusCode).toBe(202);
    }
    // Nor does another user's request for its address reach it (or the requester: the address is taken).
    const other = (await login((await ctx.account()).email, TEST_PASSWORD)).json<TokenPair>();
    const change = await post('/v1/me/email-change', { new_email: account.email }, bearer(other.access_token));

    expect(change.statusCode).toBe(202);
    expect(queued).toEqual(['verify_email', 'account_deleted_notice']);
    expect(await emailsTo(account.email)).toEqual([...queued, 'password_reset']);
    const links = await ctx.admin.sql<{ purpose: string }[]>`
      select purpose from one_time_tokens where user_id = ${account.userId}`;
    expect(links.map((link) => link.purpose)).toEqual(['reset_password']);
  });

  it('comes back through a password reset as well: the link proves control of the address, and it is audited [Q-48, R-LOG-03]', async () => {
    const account = await deletedAccount();
    ctx.clock.advance({ minutes: 1 });
    expect((await post('/v1/auth/password/forgot', { email: account.email })).statusCode).toBe(202);
    const token = (await ctx.emails()).findLast(
      (email) => email.payload.to === account.email && email.template === 'password_reset',
    )?.payload.token;
    ctx.clock.advance({ minutes: 1 });

    const reset = await post('/v1/auth/password/reset', { token, new_password: 'seven silver swans swimming' });

    expect(reset.statusCode).toBe(204);
    expect(await isDeactivated(account.userId)).toBe(false);
    expect((await login(account.email, account.password)).statusCode).toBe(401);
    expect((await login(account.email, 'seven silver swans swimming')).statusCode).toBe(200);
    expect((await post('/v1/auth/refresh', { refresh_token: account.tokens.refresh_token })).statusCode).toBe(401);
    const events = await ctx.admin.sql<{ event_type: string }[]>`
      select event_type from audit_events where user_id = ${account.userId}
        and event_type in ('account_deleted', 'password_reset_requested', 'account_reactivated',
                           'password_reset_completed')
      order by created_at, event_type`;
    expect(events.map((event) => event.event_type)).toEqual([
      'account_deleted',
      'password_reset_requested',
      'account_reactivated',
      'password_reset_completed',
    ]);
  });

  it('comes back through a password login only within the login backoff, and audited [S-01, D-04, R-LOG-03]', async () => {
    const account = await deletedAccount();
    const wrong = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      wrong.push((await login(account.email, 'not the right passphrase')).statusCode);
    }

    const blocked = await login(account.email, account.password);
    const stillDeactivated = await isDeactivated(account.userId);
    ctx.clock.advance({ seconds: 60 });
    const back = await login(account.email, account.password);

    expect(wrong).toEqual([401, 401, 401, 401, 401, 401]);
    expect([blocked.statusCode, blocked.headers['retry-after'], stillDeactivated]).toEqual([429, '60', true]);
    expect(back.statusCode).toBe(200);
    expect(await isDeactivated(account.userId)).toBe(false);
    const events = await ctx.admin.sql<{ event_type: string; outcome: string; count: number }[]>`
      select event_type, outcome, count(*)::int as count from audit_events where user_id = ${account.userId}
      group by event_type, outcome order by event_type`;
    expect(events.map((row) => ({ ...row }))).toEqual([
      { event_type: 'account_deleted', outcome: 'success', count: 1 },
      { event_type: 'account_reactivated', outcome: 'success', count: 1 },
      { event_type: 'email_verified', outcome: 'success', count: 1 },
      { event_type: 'login_failed', outcome: 'failure', count: 6 },
      { event_type: 'login_succeeded', outcome: 'success', count: 2 },
    ]);
  });
});
