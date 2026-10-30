import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { retentionJobs, RETENTION_INTERVAL_MS, type RetentionOptions } from '../../src/modules/privacy/retention.ts';
import { createDatabase, inTransaction } from '../../src/platform/db/database.ts';
import { createScheduler } from '../../src/platform/jobs/scheduler.ts';
import { createLogger } from '../../src/platform/logging/logger.ts';
import { startAccountsApp, type AccountsApp, type TestAccount } from '../helpers/accounts-app.ts';
import { contractInject } from '../helpers/contract.ts';

const MS = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };

interface TokenPair {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly session_id: string;
}

/** Retention periods of data-model §3 and data-inventory.yaml, enforced by hourly purge jobs in the worker. */
describe('retention jobs', () => {
  let ctx: AccountsApp;

  beforeAll(async () => {
    ctx = await startAccountsApp();
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    // Deleting the users cascades to everything they own.
    await ctx.admin.sql`delete from users`;
    await ctx.admin.sql`delete from rate_limit_buckets`;
    await ctx.admin.sql`delete from deleted_user_tombstones`;
    await ctx.admin.sql`delete from job_runs`;
  });

  const run = async (name: string, options: RetentionOptions = {}): Promise<number> => {
    const job = retentionJobs(options).find((candidate) => candidate.name === name);
    if (job === undefined) throw new Error(`no retention job ${name}`);
    const now = ctx.clock.now();
    return inTransaction(createDatabase(ctx.worker), (tx) => job.run(tx, now));
  };
  const at = (offsetMs: number) => new Date(ctx.clock.now().getTime() + offsetMs).toISOString();
  /** Rows in a table (the name is escaped as an identifier). */
  const total = async (table: string) =>
    (await ctx.admin.sql<{ count: number }[]>`select count(*)::int as count from ${ctx.admin.sql(table)}`)[0]?.count;
  const login = async (account: TestAccount): Promise<TokenPair> => {
    const response = await ctx.post('/v1/auth/login', {
      email: account.email,
      password: account.password,
      client: 'ios',
    });
    expect(response.statusCode).toBe(200);
    return response.json<TokenPair>();
  };

  it('runs every job hourly under a unique name', () => {
    const jobs = retentionJobs();

    expect(jobs.map((job) => job.name)).toEqual([
      'purge_unverified_accounts',
      'purge_one_time_tokens',
      'purge_session_tokens',
      'purge_sessions',
      'purge_audit_events',
      'purge_rate_limit_buckets',
      'purge_idempotency_keys',
      'purge_dead_letters',
      'purge_tombstones',
      'purge_job_runs',
    ]);
    expect(new Set(jobs.map((job) => job.intervalMs))).toEqual(new Set([RETENTION_INTERVAL_MS]));
    expect(RETENTION_INTERVAL_MS).toBe(MS.hour);
  });

  it('deletes accounts still unverified after 7 days with everything they own, and keeps verified ones [S-12]', async () => {
    const unverified = await ctx.account({ verified: false });
    const verified = await ctx.account();
    const owned = async (userId: string) =>
      [
        ...(await ctx.admin.sql<{ count: number }[]>`select count(*)::int as count from users where id = ${userId}`),
        ...(await ctx.admin.sql<
          { count: number }[]
        >`select count(*)::int as count from user_keys where user_id = ${userId}`),
        ...(await ctx.admin.sql<
          { count: number }[]
        >`select count(*)::int as count from one_time_tokens where user_id = ${userId}`),
        ...(await ctx.admin.sql<
          { count: number }[]
        >`select count(*)::int as count from email_outbox where user_id = ${userId}`),
      ].map((row) => row.count);
    expect(await owned(unverified.userId)).toEqual([1, 1, 1, 1]);

    ctx.clock.advance({ milliseconds: 7 * MS.day - 1 });
    expect(await run('purge_unverified_accounts')).toBe(0);
    ctx.clock.advance({ milliseconds: 1 });
    expect(await run('purge_unverified_accounts')).toBe(1);

    expect(await owned(unverified.userId)).toEqual([0, 0, 0, 0]);
    expect((await owned(verified.userId))[0]).toBe(1);
  });

  it('deletes used one-time tokens at once and unused ones when they expire', async () => {
    await ctx.account();
    await ctx.account({ verified: false });
    expect(await total('one_time_tokens')).toBe(2);

    expect(await run('purge_one_time_tokens')).toBe(1);
    expect((await ctx.admin.sql`select 1 from one_time_tokens where used_at is null`).length).toBe(1);
    ctx.clock.advance({ milliseconds: 30 * MS.minute - 1 });
    expect(await run('purge_one_time_tokens')).toBe(0);
    ctx.clock.advance({ milliseconds: 1 });
    expect(await run('purge_one_time_tokens')).toBe(1);
    expect(await total('one_time_tokens')).toBe(0);
  });

  it('deletes session tokens when their refresh lifetime ends, keeping rotated ones until then for reuse detection', async () => {
    const account = await ctx.account();
    const first = await login(account);
    ctx.clock.advance({ days: 10 });
    const refreshed = await ctx.post('/v1/auth/refresh', { refresh_token: first.refresh_token });
    expect(refreshed.statusCode).toBe(200);
    expect(await total('session_tokens')).toBe(2);

    expect(await run('purge_session_tokens')).toBe(0);
    ctx.clock.advance({ milliseconds: 20 * MS.day - 1 });
    expect(await run('purge_session_tokens')).toBe(0);
    ctx.clock.advance({ milliseconds: 1 });
    expect(await run('purge_session_tokens')).toBe(1);
    expect((await ctx.admin.sql`select 1 from session_tokens where rotated_at is null`).length).toBe(1);
    ctx.clock.advance({ days: 10 });
    expect(await run('purge_session_tokens')).toBe(1);
    expect(await total('session_tokens')).toBe(0);
  });

  it('deletes sessions 7 days after they were revoked, expired or last refreshable', async () => {
    const account = await ctx.account();
    const revoked = await login(account);
    const idle = await login(account);
    const ending = await login(account);
    const logout = await contractInject(ctx.app, {
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: `Bearer ${revoked.access_token}` },
    });
    expect(logout.statusCode).toBe(204);
    await ctx.admin.sql`
      update sessions set absolute_expires_at = ${at(MS.day)} where id = ${ending.session_id}`;
    const left = async () =>
      (await ctx.admin.sql<{ id: string }[]>`select id from sessions order by id`).map((row) => row.id);

    ctx.clock.advance({ milliseconds: 7 * MS.day - 1 });
    expect(await run('purge_sessions')).toBe(0);
    ctx.clock.advance({ milliseconds: 1 });
    expect(await run('purge_sessions')).toBe(1);
    expect(await left()).toEqual([idle.session_id, ending.session_id].sort());
    ctx.clock.advance({ milliseconds: MS.day - 1 });
    expect(await run('purge_sessions')).toBe(0);
    ctx.clock.advance({ milliseconds: 1 });
    expect(await run('purge_sessions')).toBe(1);
    expect(await left()).toEqual([idle.session_id]);
    ctx.clock.advance({ milliseconds: 29 * MS.day - 1 });
    expect(await run('purge_sessions')).toBe(0);
    ctx.clock.advance({ milliseconds: 1 });
    expect(await run('purge_sessions')).toBe(1);
    expect(await left()).toEqual([]);
  });

  it('deletes audit events after 90 days', async () => {
    await ctx.account();
    const events = await total('audit_events');
    expect(events).toBeGreaterThan(0);

    ctx.clock.advance({ milliseconds: 90 * MS.day - 1 });
    expect(await run('purge_audit_events')).toBe(0);
    ctx.clock.advance({ milliseconds: 1 });
    expect(await run('purge_audit_events')).toBe(events);
  });

  it('deletes rate-limit buckets untouched for 24 hours', async () => {
    const bucket = async (updatedAt: string) => {
      await ctx.admin.sql`
        insert into rate_limit_buckets (bucket_key, tokens, failures, updated_at)
        values (${randomBytes(32)}, 1, 0, ${updatedAt})`;
    };
    await bucket(at(-MS.day));
    await bucket(at(-MS.day + 1));

    expect(await run('purge_rate_limit_buckets')).toBe(1);
    expect(await total('rate_limit_buckets')).toBe(1);
  });

  it('deletes idempotency records when their 24 hours are over [ADR-0008]', async () => {
    const account = await ctx.account();
    for (const offset of [0, 1]) {
      await ctx.admin.sql`
        insert into idempotency_keys
          (id, user_id, route, key, request_hash, response_status, response_body_enc, created_at, expires_at)
        values (${randomUUID()}, ${account.userId}, 'createAchievement', ${randomUUID()}, ${randomBytes(32)}, 201,
                ${randomBytes(64)}, ${at(offset - MS.day)}, ${at(offset)})`;
    }

    expect(await run('purge_idempotency_keys')).toBe(1);
    expect(await total('idempotency_keys')).toBe(1);
  });

  it('deletes dead letters after 7 days and never touches emails still waiting', async () => {
    const account = await ctx.account({ verified: false });
    await ctx.account({ verified: false });
    await ctx.admin.sql`
      update email_outbox set dead_at = ${at(0)}, last_error_code = 'smtp_eenvelope_550'
      where user_id = ${account.userId}`;

    ctx.clock.advance({ milliseconds: 7 * MS.day - 1 });
    expect(await run('purge_dead_letters')).toBe(0);
    ctx.clock.advance({ milliseconds: 1 });
    expect(await run('purge_dead_letters')).toBe(1);
    expect(await total('email_outbox')).toBe(1);
  });

  it('deletes tombstones after 35 days and job runs after 30 days', async () => {
    for (const offset of [-35 * MS.day, -35 * MS.day + 1]) {
      await ctx.admin
        .sql`insert into deleted_user_tombstones (user_id, deleted_at) values (${randomUUID()}, ${at(offset)})`;
    }
    for (const offset of [-30 * MS.day, -30 * MS.day + 1]) {
      await ctx.admin.sql`
        insert into job_runs (id, job_name, started_at, finished_at, status, processed)
        values (${randomUUID()}, 'purge_example', ${at(offset)}, ${at(offset)}, 'succeeded', 0)`;
    }

    expect(await run('purge_tombstones')).toBe(1);
    expect(await run('purge_job_runs')).toBe(1);
    expect([await total('deleted_user_tombstones'), await total('job_runs')]).toEqual([1, 1]);
  });

  it('deletes in batches and leaves the rest of a large backlog to the next run', async () => {
    for (let index = 0; index < 5; index += 1) {
      await ctx.admin.sql`
        insert into rate_limit_buckets (bucket_key, tokens, failures, updated_at)
        values (${randomBytes(32)}, 1, 0, ${at(-2 * MS.day)})`;
    }

    expect(await run('purge_rate_limit_buckets', { batchSize: 2, maxBatches: 2 })).toBe(4);
    expect(await run('purge_rate_limit_buckets', { batchSize: 2, maxBatches: 2 })).toBe(1);
  });

  it('runs all jobs through the scheduler with the worker role and records them', async () => {
    await ctx.account({ verified: false });
    ctx.clock.advance({ days: 8 });
    const scheduler = createScheduler({
      db: createDatabase(ctx.worker),
      clock: ctx.clock,
      logger: createLogger({ service: 'questline-worker', level: 'silent' }),
      jobs: retentionJobs(),
    });

    const outcomes = await scheduler.runDue();

    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(Array(10).fill('succeeded'));
    expect(outcomes[0]).toEqual({ job: 'purge_unverified_accounts', outcome: 'succeeded', processed: 1 });
    expect((await ctx.admin.sql`select 1 from job_runs where status = 'succeeded'`).length).toBe(10);
  });
});
