import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '../../src/platform/db/client.ts';
import { createDatabase } from '../../src/platform/db/database.ts';
import { jobRuns } from '../../src/platform/db/schema/index.ts';
import { createScheduler, type ScheduledJob } from '../../src/platform/jobs/scheduler.ts';
import { createLogger } from '../../src/platform/logging/logger.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/database.ts';
import { FakeClock } from '../helpers/fake-clock.ts';
import { LogCapture } from '../helpers/log-capture.ts';

const HOUR_MS = 3_600_000;

interface RunRow {
  readonly job_name: string;
  readonly status: string;
  readonly processed: number;
  readonly error_code: string | null;
  readonly started_ms: number;
}

/** Scheduled jobs in the worker: one instance at a time, one schedule for all instances (ADR-0009, D-07). */
describe('scheduler', () => {
  let database: TestDatabase;
  let worker: DatabaseClient;
  let otherWorker: DatabaseClient;
  const clock = new FakeClock('2026-10-29T12:00:00Z');

  beforeAll(async () => {
    database = await createTestDatabase();
    const client = () => createDatabaseClient({ url: database.urls.worker, applicationName: 'questline-test' });
    worker = client();
    otherWorker = client();
  });

  afterAll(async () => {
    await Promise.all([worker.close(), otherWorker.close()]);
    await database.drop();
  });

  beforeEach(async () => {
    await worker.sql`delete from job_runs`;
  });

  const job = (name: string, run: ScheduledJob['run'] = () => Promise.resolve(3)): ScheduledJob => ({
    name,
    intervalMs: HOUR_MS,
    run,
  });
  const scheduler = (jobs: readonly ScheduledJob[], logs = new LogCapture(), client = worker) =>
    createScheduler({
      db: createDatabase(client),
      clock,
      logger: createLogger({ service: 'questline-worker', level: 'info' }, logs.stream),
      jobs,
    });
  const runs = () =>
    worker.sql<RunRow[]>`
      select job_name, status, processed, error_code, extract(epoch from started_at)::float8 * 1000 as started_ms
      from job_runs order by started_at, job_name`;

  it('runs a due job, records the run and skips the job until its interval has passed', async () => {
    const seen: number[] = [];
    const run = scheduler([
      job('purge_example', (_tx, now) => {
        seen.push(now.getTime());
        return Promise.resolve(3);
      }),
    ]);
    const first = clock.now().getTime();

    expect(await run.runDue()).toEqual([{ job: 'purge_example', outcome: 'succeeded', processed: 3 }]);
    expect(await run.runDue()).toEqual([{ job: 'purge_example', outcome: 'skipped' }]);
    clock.advance({ milliseconds: HOUR_MS - 1 });
    expect(await run.runDue()).toEqual([{ job: 'purge_example', outcome: 'skipped' }]);
    clock.advance({ milliseconds: 1 });
    expect(await run.runDue()).toEqual([{ job: 'purge_example', outcome: 'succeeded', processed: 3 }]);

    expect(seen).toEqual([first, first + HOUR_MS]);
    expect(await runs()).toEqual([
      { job_name: 'purge_example', status: 'succeeded', processed: 3, error_code: null, started_ms: first },
      { job_name: 'purge_example', status: 'succeeded', processed: 3, error_code: null, started_ms: first + HOUR_MS },
    ]);
  });

  it('keeps one schedule for all worker instances: a job that just ran elsewhere is not due', async () => {
    const shared = job('purge_shared');

    expect(await scheduler([shared]).runDue()).toMatchObject([{ outcome: 'succeeded' }]);
    expect(await scheduler([shared], new LogCapture(), otherWorker).runDue()).toEqual([
      { job: 'purge_shared', outcome: 'skipped' },
    ]);
  });

  it('never runs a job on two worker instances at once (advisory lock)', async () => {
    let release: () => void = () => undefined;
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const slow = job(
      'purge_slow',
      () =>
        new Promise<number>((resolve) => {
          release = () => {
            resolve(1);
          };
          started();
        }),
    );

    const first = scheduler([slow]).runDue();
    await running;
    expect(await scheduler([slow], new LogCapture(), otherWorker).runDue()).toEqual([
      { job: 'purge_slow', outcome: 'skipped' },
    ]);
    release();

    expect(await first).toEqual([{ job: 'purge_slow', outcome: 'succeeded', processed: 1 }]);
    expect((await runs()).map((row) => row.status)).toEqual(['succeeded']);
  });

  it('records a failed run with an error class only, rolls its work back and still runs the next job', async () => {
    const logs = new LogCapture();
    await scheduler([job('purge_seed')]).runDue();
    const broken = job('purge_broken', async (tx) => {
      await tx.delete(jobRuns);
      await worker.sql`select 1 / 0`;
      return 0;
    });

    expect(
      await scheduler([broken, job('purge_next'), job('purge_idle', () => Promise.resolve(0))], logs).runDue(),
    ).toEqual([
      { job: 'purge_broken', outcome: 'failed' },
      { job: 'purge_next', outcome: 'succeeded', processed: 3 },
      { job: 'purge_idle', outcome: 'succeeded', processed: 0 },
    ]);

    expect((await runs()).map((row) => [row.job_name, row.status, row.processed, row.error_code])).toEqual([
      ['purge_broken', 'failed', 0, 'pg_22012'],
      ['purge_idle', 'succeeded', 0, null],
      ['purge_next', 'succeeded', 3, null],
      ['purge_seed', 'succeeded', 3, null],
    ]);
    expect(logs.records()).toEqual([
      expect.objectContaining({
        level: 'error',
        msg: 'job failed',
        job: 'purge_broken',
        err: { name: 'PostgresError', code: '22012' },
      }),
      expect.objectContaining({ level: 'info', msg: 'job finished', job: 'purge_next', processed: 3 }),
    ]);
  });

  it('retries a failed job only after its interval, so a broken job cannot hammer the database', async () => {
    let attempts = 0;
    const flaky = job('purge_flaky', () => {
      attempts += 1;
      return attempts === 1 ? Promise.reject(new TypeError('first run fails')) : Promise.resolve(2);
    });
    const run = scheduler([flaky]);

    expect(await run.runDue()).toEqual([{ job: 'purge_flaky', outcome: 'failed' }]);
    expect(await run.runDue()).toEqual([{ job: 'purge_flaky', outcome: 'skipped' }]);
    clock.advance({ hours: 1 });
    expect(await run.runDue()).toEqual([{ job: 'purge_flaky', outcome: 'succeeded', processed: 2 }]);
    expect((await runs()).map((row) => [row.status, row.error_code])).toEqual([
      ['failed', 'typeerror'],
      ['succeeded', null],
    ]);
  });
});
