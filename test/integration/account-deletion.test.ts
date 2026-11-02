import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { retentionJobs } from '../../src/modules/privacy/retention.ts';
import { createDatabase, inTransaction } from '../../src/platform/db/database.ts';
import { startAccountsApp, TEST_PASSWORD, type AccountsApp } from '../helpers/accounts-app.ts';
import { contractInject } from '../helpers/contract.ts';
import { bearer, goalUser, loggedInAgain, type GoalUser } from '../helpers/goals.ts';

const START = '2026-10-29T12:00:00Z';
const START_MS = Date.parse(START);
const DAY_MS = 24 * 60 * 60 * 1000;

interface TokenPair {
  readonly access_token: string;
  readonly refresh_token: string;
}

/**
 * `DELETE /v1/me` (R-PRIV-06, Q-11): the account is deactivated at once — every session and emailed link ends, the
 * request is audited and the owner is told the deadline — and only a password login within 30 days brings it back.
 */
describe('account deletion request [R-PRIV-06, R-AUTH-06, E-13, A-22]', () => {
  let ctx: AccountsApp;

  const deleteAccount = (token: string) =>
    contractInject(ctx.app, { method: 'DELETE', url: '/v1/me', headers: bearer(token) });
  const me = (token: string) => contractInject(ctx.app, { method: 'GET', url: '/v1/me', headers: bearer(token) });
  const login = (email: string, password = TEST_PASSWORD) =>
    ctx.post('/v1/auth/login', { email, password, client: 'android' });
  const accountOf = async (userId: string) =>
    (
      await ctx.admin.sql<{ deactivated_ms: number | null; version: number }[]>`
        select extract(epoch from deactivated_at)::float8 * 1000 as deactivated_ms, version
        from users where id = ${userId}`
    ).map((row) => ({ ...row }));
  const sessionsOf = async (userId: string) =>
    (
      await ctx.admin.sql<{ revoked_ms: number | null; revoked_reason: string | null }[]>`
        select extract(epoch from revoked_at)::float8 * 1000 as revoked_ms, revoked_reason
        from sessions where user_id = ${userId} order by created_at`
    ).map((row) => ({ ...row }));
  const tokensOf = async (userId: string) => {
    const [row] = await ctx.admin.sql<{ session_tokens: number; one_time_tokens: number }[]>`
      select (select count(*)::int from session_tokens where user_id = ${userId}) as session_tokens,
        (select count(*)::int from one_time_tokens where user_id = ${userId}) as one_time_tokens`;
    return { ...row };
  };
  const eventsOf = async (userId: string, type: string) =>
    (
      await ctx.admin.sql<{ outcome: string; session_id: string | null; ip_prefix: string | null; client: null }[]>`
        select outcome, session_id, ip_prefix::text as ip_prefix, client from audit_events
        where user_id = ${userId} and event_type = ${type} order by created_at`
    ).map((row) => ({ ...row }));
  const noticesOf = async (userId: string) =>
    (await ctx.emails())
      .filter((email) => email.userId === userId && email.template === 'account_deleted_notice')
      .map((email) => email.payload);
  const linkTo = async (email: string, template: string) =>
    (await ctx.emails()).findLast((queued) => queued.payload.to === email && queued.template === template)?.payload
      .token ?? 'missing';
  const sessionIdOf = async (userId: string) =>
    (await ctx.admin.sql<{ id: string }[]>`select id from sessions where user_id = ${userId}`)[0]?.id;
  /** API connections of this test database that wait for a row lock. */
  const waitingForLocks = async () => {
    const [row] = await ctx.admin.sql<{ count: string }[]>`
      select count(*) from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and usename = 'questline_app'`;
    return Number(row?.count);
  };

  beforeAll(async () => {
    ctx = await startAccountsApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(() => {
    ctx.clock.set(START);
  });

  it('deactivates the account at once: 202 with the deadline 30 days on, audited, the owner told [R-PRIV-06, R-LOG-03]', async () => {
    const user = await goalUser(ctx);
    const sessionId = await sessionIdOf(user.userId);

    const response = await deleteAccount(user.token);

    expect(response.statusCode).toBe(202);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({ deletion_scheduled_for: '2026-11-28T12:00:00.000Z' });
    expect(await accountOf(user.userId)).toEqual([{ deactivated_ms: START_MS, version: 3 }]);
    expect(await eventsOf(user.userId, 'account_deleted')).toEqual([
      { outcome: 'success', session_id: sessionId, ip_prefix: '127.0.0.0/24', client: null },
    ]);
    expect(await noticesOf(user.userId)).toEqual([{ to: user.email, locale: 'de-CH' }]);
  });

  it('ends every session of the account on every device: its access and refresh tokens → 401 [E-13, R-AUTH-05]', async () => {
    const user = await goalUser(ctx);
    const phone = (await login(user.email)).json<TokenPair>();
    const bystander = await goalUser(ctx);

    expect((await deleteAccount(user.token)).statusCode).toBe(202);

    expect(await sessionsOf(user.userId)).toEqual([
      { revoked_ms: START_MS, revoked_reason: 'account_deleted' },
      { revoked_ms: START_MS, revoked_reason: 'account_deleted' },
    ]);
    expect((await tokensOf(user.userId)).session_tokens).toBe(0);
    expect([(await me(user.token)).statusCode, (await me(phone.access_token)).statusCode]).toEqual([401, 401]);
    const refreshed = await ctx.post('/v1/auth/refresh', { refresh_token: phone.refresh_token });
    expect([refreshed.statusCode, refreshed.json()]).toMatchObject([
      401,
      { type: 'urn:questline:problem:invalid-token' },
    ]);
    expect((await me(bystander.token)).statusCode).toBe(200);
  });

  it('voids every emailed link of the account: a pending reset, email change or verification link → 401 [E-13, A-22]', async () => {
    const user = await goalUser(ctx);
    const verification = await linkTo(user.email, 'verify_email');
    const newAddress = `moved-${randomUUID().slice(0, 8)}@example.test`;
    expect((await ctx.post('/v1/auth/password/forgot', { email: user.email })).statusCode).toBe(202);
    expect((await ctx.post('/v1/me/email-change', { new_email: newAddress }, bearer(user.token))).statusCode).toBe(202);
    const [reset, change] = [
      await linkTo(user.email, 'password_reset'),
      await linkTo(newAddress, 'email_change_verify'),
    ];

    expect((await deleteAccount(user.token)).statusCode).toBe(202);

    expect(await tokensOf(user.userId)).toEqual({ session_tokens: 0, one_time_tokens: 0 });
    const answers = [
      await ctx.post('/v1/auth/password/reset', { token: reset, new_password: 'a brand new passphrase here' }),
      await ctx.post('/v1/me/email-change/confirm', { token: change }),
      await ctx.post('/v1/auth/verify-email', { token: verification }),
    ];
    expect(answers.map((answer) => answer.statusCode)).toEqual([401, 401, 401]);
    expect(await accountOf(user.userId)).toEqual([{ deactivated_ms: START_MS, version: 3 }]);
  });

  it('needs the password entered within 10 minutes: later → 403 and nothing changes, until the user re-authenticates [R-AUTH-06, E-03]', async () => {
    const user = await goalUser(ctx);
    ctx.clock.advance({ minutes: 10 });

    const stale = await deleteAccount(user.token);

    expect(stale.statusCode).toBe(403);
    expect(stale.json()).toMatchObject({ type: 'urn:questline:problem:reauthentication-required' });
    expect(await accountOf(user.userId)).toEqual([{ deactivated_ms: null, version: 2 }]);
    expect(await sessionsOf(user.userId)).toEqual([{ revoked_ms: null, revoked_reason: null }]);
    expect(await eventsOf(user.userId, 'account_deleted')).toEqual([]);
    expect(await noticesOf(user.userId)).toEqual([]);
    expect((await ctx.post('/v1/auth/reauth', { password: TEST_PASSWORD }, bearer(user.token))).statusCode).toBe(204);
    expect((await deleteAccount(user.token)).statusCode).toBe(202);
  });

  it('deletes once when asked from several devices at the same time: one 202, the others 401 [E-13]', async () => {
    const user = await goalUser(ctx);
    const devices: GoalUser[] = [user, await loggedInAgain(ctx, user), await loggedInAgain(ctx, user)];
    // Hold the account row until every request waits for it, so they truly race (deterministic, no sleeps).
    const { promise: released, resolve: release } = Promise.withResolvers<undefined>();
    const { promise: isLocked, resolve: locked } = Promise.withResolvers<undefined>();
    const holder = ctx.admin.sql.begin(async (tx) => {
      await tx`select id from users where id = ${user.userId} for update`;
      locked(undefined);
      await released;
    });
    await isLocked;

    const racing = Promise.all(devices.map((device) => deleteAccount(device.token)));
    await expect.poll(waitingForLocks, { timeout: 5000, interval: 10 }).toBe(devices.length);
    release(undefined);
    await holder;
    const statuses = (await racing).map((response) => response.statusCode);

    expect(statuses.sort()).toEqual([202, 401, 401]);
    expect(await eventsOf(user.userId, 'account_deleted')).toHaveLength(1);
    expect(await noticesOf(user.userId)).toHaveLength(1);
  });

  it('answers a wrong password like an unknown address, and the right one within 30 days reactivates [R-AUTH-07, E-13]', async () => {
    const user = await goalUser(ctx);
    expect((await deleteAccount(user.token)).statusCode).toBe(202);
    const withoutId = (body: Record<string, unknown>) => ({ ...body, request_id: undefined });

    const wrong = await login(user.email, 'not the password at all');
    const unknown = await login(`nobody-${randomUUID().slice(0, 8)}@example.test`, 'not the password at all');
    ctx.clock.advance({ days: 29, hours: 23, minutes: 59, seconds: 59 });
    const right = await login(user.email);

    expect([wrong.statusCode, unknown.statusCode]).toEqual([401, 401]);
    expect(withoutId(wrong.json<Record<string, unknown>>())).toEqual(
      withoutId(unknown.json<Record<string, unknown>>()),
    );
    expect(right.statusCode).toBe(200);
    expect(await accountOf(user.userId)).toEqual([{ deactivated_ms: null, version: 4 }]);
    expect(await eventsOf(user.userId, 'account_reactivated')).toHaveLength(1);
    expect((await me(right.json<TokenPair>().access_token)).statusCode).toBe(200);
  });
});

/**
 * The hard delete (R-PRIV-06, Q-13): 30 days after the request the retention job deletes the account with every row
 * it owns — its wrapped data key too, so the ciphertext left in backups cannot be read with the live database — and
 * writes its tombstone in the same transaction, for replay after a restore. An own database: earlier deletions of
 * the suite above would be due too.
 */
describe('hard delete 30 days after the request [R-PRIV-06, Q-13, I-18]', () => {
  let ctx: AccountsApp;

  const purge = async () => {
    const job = retentionJobs().find((candidate) => candidate.name === 'purge_deleted_accounts');
    if (job === undefined) throw new Error('no retention job purge_deleted_accounts');
    const now = ctx.clock.now();
    return inTransaction(createDatabase(ctx.worker), (tx) => job.run(tx, now));
  };
  const deleteAccount = async (token: string) => {
    const response = await contractInject(ctx.app, { method: 'DELETE', url: '/v1/me', headers: bearer(token) });
    if (response.statusCode !== 202) throw new Error(`deletion failed: ${String(response.statusCode)}`);
  };
  const login = (email: string, password = TEST_PASSWORD) =>
    ctx.post('/v1/auth/login', { email, password, client: 'ios' });
  const create = async (url: string, token: string, body: unknown) => {
    const response = await ctx.post(url, body, { ...bearer(token), 'idempotency-key': randomUUID() });
    if (response.statusCode !== 201) throw new Error(`${url} answered ${String(response.statusCode)}`);
    return response.json<{ id: string }>();
  };
  /** The user's rows per table — the account and every table with a `user_id` but the tombstones — if any. */
  const rowsOf = async (userId: string) => {
    const tables = await ctx.admin.sql<{ table_name: string }[]>`
      select table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'user_id' and table_name <> 'deleted_user_tombstones'`;
    const counts: Record<string, number> = {};
    const [account] = await ctx.admin.sql<{ count: number }[]>`
      select count(*)::int as count from users where id = ${userId}`;
    if (account !== undefined && account.count > 0) counts['users'] = account.count;
    for (const { table_name: table } of tables) {
      const [row] = await ctx.admin.sql<{ count: number }[]>`
        select count(*)::int as count from ${ctx.admin.sql(table)} where user_id = ${userId}`;
      if (row !== undefined && row.count > 0) counts[table] = row.count;
    }
    return counts;
  };
  const tombstonesOf = async (userId: string) =>
    (
      await ctx.admin.sql<{ deleted_ms: number }[]>`
        select extract(epoch from deleted_at)::float8 * 1000 as deleted_ms
        from deleted_user_tombstones where user_id = ${userId}`
    ).map((row) => ({ ...row }));
  /** Worker connections of this test database that wait for a row lock. */
  const workersWaiting = async () => {
    const [row] = await ctx.admin.sql<{ count: string }[]>`
      select count(*) from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and usename = 'questline_worker'`;
    return Number(row?.count);
  };
  /** API connections of this test database that wait for a row lock. */
  const apiWaiting = async () => {
    const [row] = await ctx.admin.sql<{ count: string }[]>`
      select count(*) from pg_stat_activity
      where datname = current_database() and wait_event_type = 'Lock' and usename = 'questline_app'`;
    return Number(row?.count);
  };

  beforeAll(async () => {
    ctx = await startAccountsApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    ctx.clock.set(START);
    await ctx.admin.sql`delete from users`;
    await ctx.admin.sql`delete from deleted_user_tombstones`;
  });

  it('deletes every row the account owned, its wrapped data key included, and leaves only its tombstone', async () => {
    const user = await goalUser(ctx);
    const achievement = await create('/v1/achievements', user.token, { title: 'Run a marathon' });
    const quest = await create(`/v1/achievements/${achievement.id}/quests`, user.token, {
      title: 'Run 42 km',
      type: 'one_time',
      size: 'S',
    });
    await create(`/v1/quests/${quest.id}/check-ins`, user.token, { local_date: '2026-10-29' });
    await deleteAccount(user.token);
    const before = await rowsOf(user.userId);
    ctx.clock.advance({ days: 30 });

    expect(await purge()).toBe(1);

    expect(Object.keys(before)).toEqual(
      expect.arrayContaining([
        'users',
        'user_keys',
        'consents',
        'sessions',
        'achievements',
        'quests',
        'check_ins',
        'xp_events',
        'audit_events',
        'idempotency_keys',
        'email_outbox',
      ]),
    );
    expect(await rowsOf(user.userId)).toEqual({});
    expect(await tombstonesOf(user.userId)).toEqual([{ deleted_ms: START_MS + 30 * DAY_MS }]);
  });

  it('keeps an account whose owner logged in again, however long ago the request was', async () => {
    const user = await goalUser(ctx);
    await deleteAccount(user.token);
    ctx.clock.advance({ days: 29 });
    expect((await login(user.email)).statusCode).toBe(200);
    ctx.clock.advance({ days: 2 });

    expect(await purge()).toBe(0);

    expect(await rowsOf(user.userId)).toHaveProperty('users', 1);
    expect(await tombstonesOf(user.userId)).toEqual([]);
  });

  it('keeps an account reactivated while the job deletes it: no row deleted, no tombstone written', async () => {
    const user = await goalUser(ctx);
    await deleteAccount(user.token);
    ctx.clock.advance({ days: 30 });
    // A login that began just before the deadline holds the account row and reactivates it while the job runs.
    const { promise: released, resolve: release } = Promise.withResolvers<undefined>();
    const { promise: isLocked, resolve: locked } = Promise.withResolvers<undefined>();
    const reactivation = ctx.admin.sql.begin(async (tx) => {
      await tx`update users set deactivated_at = null where id = ${user.userId}`;
      locked(undefined);
      await released;
    });
    await isLocked;

    const job = purge();
    await expect.poll(workersWaiting, { timeout: 5000, interval: 10 }).toBe(1);
    release(undefined);
    await reactivation;

    expect(await job).toBe(0);
    expect(await rowsOf(user.userId)).toHaveProperty('users', 1);
    expect(await tombstonesOf(user.userId)).toEqual([]);
  });

  it('lets a password reset begun before the deadline finish first, without a deadlock: the job then deletes nothing [Q-48]', async () => {
    const user = await goalUser(ctx);
    await deleteAccount(user.token);
    const deadline = START_MS + 30 * DAY_MS;
    ctx.clock.set(new Date(deadline - 10 * 60_000).toISOString());
    expect((await ctx.post('/v1/auth/password/forgot', { email: user.email })).statusCode).toBe(202);
    const token = (await ctx.emails()).findLast(
      (email) => email.payload.to === user.email && email.template === 'password_reset',
    )?.payload.token;
    ctx.clock.set(new Date(deadline - 1).toISOString());
    // Hold the reset link's row: the reset waits for it while holding the account row, which the job needs as well.
    const { promise: released, resolve: release } = Promise.withResolvers<undefined>();
    const { promise: isLocked, resolve: locked } = Promise.withResolvers<undefined>();
    const holder = ctx.admin.sql.begin(async (tx) => {
      await tx`select id from one_time_tokens where user_id = ${user.userId} for update`;
      locked(undefined);
      await released;
    });
    await isLocked;

    const resetting = ctx.post('/v1/auth/password/reset', { token, new_password: 'a brand new passphrase here' });
    await expect.poll(apiWaiting, { timeout: 5000, interval: 10 }).toBe(1);
    ctx.clock.set(new Date(deadline).toISOString());
    const job = purge();
    await expect.poll(workersWaiting, { timeout: 5000, interval: 10 }).toBe(1);
    release(undefined);
    await holder;

    expect((await resetting).statusCode).toBe(204);
    expect(await job).toBe(0);
    expect(await rowsOf(user.userId)).toHaveProperty('users', 1);
    expect(await tombstonesOf(user.userId)).toEqual([]);
    expect((await login(user.email, 'a brand new passphrase here')).statusCode).toBe(200);
  });

  it('answers a reset that waited for an account the job deleted at the deadline with 401: nothing of it is left [Q-48]', async () => {
    const user = await goalUser(ctx);
    await deleteAccount(user.token);
    const deadline = START_MS + 30 * DAY_MS;
    ctx.clock.set(new Date(deadline - 10 * 60_000).toISOString());
    expect((await ctx.post('/v1/auth/password/forgot', { email: user.email })).statusCode).toBe(202);
    const token = (await ctx.emails()).findLast(
      (email) => email.payload.to === user.email && email.template === 'password_reset',
    )?.payload.token;
    // Hold the reset link's row: the job deletes the account and then waits for it, holding the account row.
    const { promise: released, resolve: release } = Promise.withResolvers<undefined>();
    const { promise: isLocked, resolve: locked } = Promise.withResolvers<undefined>();
    const holder = ctx.admin.sql.begin(async (tx) => {
      await tx`select id from one_time_tokens where user_id = ${user.userId} for update`;
      locked(undefined);
      await released;
    });
    await isLocked;
    ctx.clock.set(new Date(deadline).toISOString());
    const job = purge();
    await expect.poll(workersWaiting, { timeout: 5000, interval: 10 }).toBe(1);
    // A reset begun a moment before the deadline still finds the link usable, then waits for the account row.
    ctx.clock.set(new Date(deadline - 1).toISOString());

    const resetting = ctx.post('/v1/auth/password/reset', { token, new_password: 'a brand new passphrase here' });
    await expect.poll(apiWaiting, { timeout: 5000, interval: 10 }).toBe(1);
    release(undefined);
    await holder;

    expect((await resetting).statusCode).toBe(401);
    expect(await job).toBe(1);
    expect(await rowsOf(user.userId)).toEqual({});
    expect(await tombstonesOf(user.userId)).toEqual([{ deleted_ms: deadline }]);
  });

  it('frees the address: the old password no longer logs in, and the address can be registered and verified again', async () => {
    const user = await goalUser(ctx);
    await deleteAccount(user.token);
    ctx.clock.advance({ days: 30 });
    await purge();

    const oldLogin = await login(user.email);
    const again = await ctx.post('/v1/auth/register', {
      email: user.email,
      password: TEST_PASSWORD,
      privacy_policy_version: '2026-10-01',
      age_confirmed: true,
    });

    expect([oldLogin.statusCode, again.statusCode]).toEqual([401, 202]);
    const [account] = await ctx.admin.sql<{ id: string }[]>`
      select id from users where email_blind_index = ${ctx.blindIndex(user.email)}`;
    expect(account?.id).toEqual(expect.any(String));
    expect(account?.id).not.toBe(user.userId);
    const queued = (await ctx.emails()).filter((email) => email.payload.to === user.email);
    expect(queued.map((email) => email.template)).toEqual(['verify_email']);
    const verified = await ctx.post('/v1/auth/verify-email', { token: queued[0]?.payload.token ?? 'missing' });
    expect(verified.statusCode).toBe(204);
  });
});
