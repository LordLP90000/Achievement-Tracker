import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { inTransaction, type Database, type Transaction } from '../db/database.ts';
import { tryTransactionLock } from '../db/locks.ts';
import type { Clock } from '../time/clock.ts';
import { lastJobRunStartedAt, recordJobRun } from './job-runs-repository.ts';

/**
 * Fixed-interval jobs in the worker (architecture §4.7, ADR-0009). A job runs in one transaction that first takes an
 * advisory lock named after it, so only one worker instance runs it at a time, and then checks `job_runs`, so all
 * instances share one schedule. Its work and its `job_runs` row commit together; a failure rolls the work back and
 * is recorded on its own, and the job waits for its interval before it is tried again.
 */

export interface ScheduledJob {
  /** Lower-case identifier, stored in `job_runs` and used as the lock name. */
  readonly name: string;
  readonly intervalMs: number;
  /** Does the work in the job's transaction (worker role) as of `now`; returns the number of rows processed. */
  run(tx: Transaction, now: Date): Promise<number>;
}

export type JobOutcome =
  | { readonly job: string; readonly outcome: 'succeeded'; readonly processed: number }
  | { readonly job: string; readonly outcome: 'skipped' | 'failed' };

export interface SchedulerDependencies {
  /** Worker role. */
  readonly db: Database;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly jobs: readonly ScheduledJob[];
}

export interface Scheduler {
  /** Runs every job that is due, one after the other; a failing job does not stop the others. */
  runDue(): Promise<JobOutcome[]>;
}

const SQLSTATE = /^[\dA-Z]{5}$/;
const ERROR_NAME = /^\w{1,40}$/;

/** A failure's class for `job_runs.error_code`: the SQLSTATE of a database error, else the error's name. */
export function jobErrorCode(error: unknown): string {
  const { name, code } = (typeof error === 'object' && error !== null ? error : {}) as {
    readonly name?: unknown;
    readonly code?: unknown;
  };
  if (name === 'PostgresError' && typeof code === 'string' && SQLSTATE.test(code)) return `pg_${code.toLowerCase()}`;
  return typeof name === 'string' && ERROR_NAME.test(name) ? name.toLowerCase() : 'unknown';
}

export function createScheduler(deps: SchedulerDependencies): Scheduler {
  async function runIfDue(job: ScheduledJob): Promise<JobOutcome> {
    const startedAt = deps.clock.now();
    const run = { jobName: job.name, startedAt };
    try {
      const processed = await inTransaction(deps.db, async (tx) => {
        if (!(await tryTransactionLock(tx, `questline-job:${job.name}`))) return undefined;
        const last = await lastJobRunStartedAt(tx, job.name);
        if (last !== undefined && startedAt.getTime() - last.getTime() < job.intervalMs) return undefined;
        const count = await job.run(tx, startedAt);
        await recordJobRun(tx, {
          ...run,
          id: randomUUID(),
          finishedAt: deps.clock.now(),
          status: 'succeeded',
          processed: count,
          errorCode: null,
        });
        return count;
      });
      if (processed === undefined) return { job: job.name, outcome: 'skipped' };
      // Most hourly runs find nothing to delete: only work done is worth an info line.
      if (processed > 0) deps.logger.info({ job: job.name, processed }, 'job finished');
      return { job: job.name, outcome: 'succeeded', processed };
    } catch (error) {
      await recordJobRun(deps.db, {
        ...run,
        id: randomUUID(),
        finishedAt: deps.clock.now(),
        status: 'failed',
        processed: 0,
        errorCode: jobErrorCode(error),
      });
      deps.logger.error({ job: job.name, err: error }, 'job failed');
      return { job: job.name, outcome: 'failed' };
    }
  }

  return {
    async runDue() {
      const outcomes: JobOutcome[] = [];
      for (const job of deps.jobs) outcomes.push(await runIfDue(job));
      return outcomes;
    },
  };
}
