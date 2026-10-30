import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startWorker } from '../../src/main/worker.ts';
import { retentionJobs } from '../../src/modules/privacy/retention.ts';
import type { EmailConfig, WorkerConfig } from '../../src/platform/config/config.ts';
import type { ScheduledJob } from '../../src/platform/jobs/scheduler.ts';
import { createLogger } from '../../src/platform/logging/logger.ts';
import { startAccountsApp, TEST_PASSWORD, type AccountsApp } from '../helpers/accounts-app.ts';
import { FakeEmailSender, tokenIn } from '../helpers/fake-email-sender.ts';
import { LogCapture } from '../helpers/log-capture.ts';

const EMAIL: EmailConfig = {
  // Port 9 (discard) on the loopback: nothing listens there, so any delivery attempt fails at once.
  smtp: {
    host: '127.0.0.1',
    port: 9,
    tls: 'starttls',
    user: 'relay-user',
    password: 'relay-password',
    from: 'no-reply@questline.test',
  },
  linkBaseUrl: 'https://app.questline.test',
};

/** The worker process wiring: the outbox poller on the worker role with the configured relay (architecture §4.7). */
describe('startWorker', () => {
  let ctx: AccountsApp;
  let config: WorkerConfig;

  beforeAll(async () => {
    ctx = await startAccountsApp();
    config = { appEnv: 'test', logLevel: 'info', databaseUrl: ctx.database.urls.worker, email: EMAIL };
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await ctx.admin.sql`delete from email_outbox`;
    await ctx.admin.sql`delete from job_runs`;
  });

  const loggerFor = (logs: LogCapture) => createLogger({ service: 'questline-worker', level: 'info' }, logs.stream);
  const register = async () => {
    const email = `worker-${randomUUID().slice(0, 8)}@example.test`;
    const response = await ctx.post('/v1/auth/register', {
      email,
      password: TEST_PASSWORD,
      privacy_policy_version: '2026-10-01',
      age_confirmed: true,
    });
    expect(response.statusCode).toBe(202);
    return email;
  };

  it('delivers queued emails through the sender while it runs, and closes the sender when stopped', async () => {
    const email = await register();
    const sender = new FakeEmailSender();
    const logs = new LogCapture();

    const worker = await startWorker(config, { kek: ctx.kek }, loggerFor(logs), {
      emailSender: sender,
      clock: ctx.clock,
      pollIntervalMs: 20,
      jobs: [],
    });
    await vi.waitFor(() => {
      expect(sender.sent.map((message) => message.to)).toEqual([email]);
    });
    await worker.stop();

    expect(sender.closed).toBe(true);
    expect((await ctx.post('/v1/auth/verify-email', { token: tokenIn(sender.sent[0]) })).statusCode).toBe(204);
    expect(logs.records().map((record) => record['msg'])).toEqual(['worker ready', 'email sent']);
    expect(logs.records()[0]).toMatchObject({ email_delivery: 'on' });
  });

  it('runs no further round once stopped', async () => {
    const sender = new FakeEmailSender();
    const logs = new LogCapture();
    let jobRuns = 0;
    const counting: ScheduledJob = {
      name: 'count_runs',
      intervalMs: 0,
      run: () => {
        jobRuns += 1;
        return Promise.resolve(0);
      },
    };
    const worker = await startWorker(config, { kek: ctx.kek }, loggerFor(logs), {
      emailSender: sender,
      clock: ctx.clock,
      pollIntervalMs: 10,
      jobs: [counting],
      schedulerTickMs: 10,
    });
    await worker.stop();

    await register();
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(sender.attempts).toBe(0);
    expect(jobRuns).toBe(1);
    expect(logs.records().map((record) => record['msg'])).toEqual(['worker ready']);
  });

  it('builds the SMTP sender from the configuration when none is given', async () => {
    const logs = new LogCapture();

    const worker = await startWorker(config, { kek: ctx.kek }, loggerFor(logs), { jobs: [] });
    await worker.stop();

    expect(logs.records()[0]).toMatchObject({ msg: 'worker ready', email_delivery: 'on' });
  });

  it('leaves emails queued without SMTP settings (development and tests only) and says so', async () => {
    await register();
    const logs = new LogCapture();

    const worker = await startWorker({ ...config, email: undefined }, { kek: ctx.kek }, loggerFor(logs), {
      pollIntervalMs: 20,
      jobs: [],
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await worker.stop();

    const [queued] = await ctx.worker.sql<{ count: number }[]>`select count(*)::int as count from email_outbox`;
    expect(queued?.count).toBe(1);
    expect(logs.records()).toEqual([
      expect.objectContaining({ level: 'warn', msg: 'email delivery off: no SMTP settings, emails stay queued' }),
      expect.objectContaining({ level: 'info', msg: 'worker ready', email_delivery: 'off' }),
    ]);
  });

  it('logs a failed delivery round by error class only and keeps polling', async () => {
    const logs = new LogCapture();
    const broken = {
      now: (): Date => {
        throw new Error('clock unavailable at 2026-10-29T12:00:00Z');
      },
    };

    const worker = await startWorker(config, { kek: ctx.kek }, loggerFor(logs), {
      emailSender: new FakeEmailSender(),
      clock: broken,
      pollIntervalMs: 20,
    });
    await vi.waitFor(() => {
      expect(
        logs.records().filter((record) => record['msg'] === 'email delivery round failed').length,
      ).toBeGreaterThanOrEqual(2);
    });
    await worker.stop();

    expect(logs.records()).toContainEqual(
      expect.objectContaining({ level: 'error', msg: 'email delivery round failed', err: { name: 'Error' } }),
    );
    expect(logs.records()).toContainEqual(
      expect.objectContaining({ level: 'error', msg: 'scheduled jobs failed', err: { name: 'Error' } }),
    );
    expect(logs.text).not.toContain('clock unavailable');
  });

  it('runs the retention jobs on their schedule with the worker role, also without SMTP settings', async () => {
    const email = await register();
    const [user] = await ctx.worker.sql<{ id: string }[]>`
      select id from users where email_blind_index = ${ctx.blindIndex(email)}`;
    ctx.clock.advance({ days: 8 });
    const logs = new LogCapture();

    const worker = await startWorker({ ...config, email: undefined }, { kek: ctx.kek }, loggerFor(logs), {
      clock: ctx.clock,
      schedulerTickMs: 20,
    });
    await vi.waitFor(async () => {
      const runs = await ctx.worker.sql<{ count: number }[]>`select count(*)::int as count from job_runs`;
      expect(runs[0]?.count).toBe(retentionJobs().length);
    });
    await worker.stop();

    const left = await ctx.worker.sql`select 1 from users where id = ${user?.id ?? ''}`;
    expect(left).toHaveLength(0);
    expect(logs.records()).toContainEqual(
      expect.objectContaining({ level: 'info', msg: 'job finished', job: 'purge_unverified_accounts' }),
    );
  });
});
