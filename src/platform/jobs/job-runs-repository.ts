import { desc, eq } from 'drizzle-orm';
import type { Database, Transaction } from '../db/database.ts';
import { jobRuns } from '../db/schema/index.ts';

/** `job_runs` (data-model §3.6): one row per finished run of a scheduled job; no personal data. Worker role. */
export interface JobRun {
  readonly id: string;
  readonly jobName: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly status: 'succeeded' | 'failed';
  readonly processed: number;
  /** An error class such as `pg_57014`, never message text. */
  readonly errorCode: string | null;
}

/** When the job last started, whatever the outcome: a failed job waits for its interval like a successful one. */
export async function lastJobRunStartedAt(tx: Transaction, jobName: string): Promise<Date | undefined> {
  const [row] = await tx
    .select({ startedAt: jobRuns.startedAt })
    .from(jobRuns)
    .where(eq(jobRuns.jobName, jobName))
    .orderBy(desc(jobRuns.startedAt))
    .limit(1);
  return row?.startedAt;
}

export async function recordJobRun(db: Database | Transaction, run: JobRun): Promise<void> {
  await db.insert(jobRuns).values(run);
}
