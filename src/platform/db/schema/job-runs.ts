import { sql } from 'drizzle-orm';
import { check, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/** Operational record of background job executions; no personal data (docs/data-model.md, retention 30 days). */
export const jobRuns = pgTable(
  'job_runs',
  {
    id: uuid('id').primaryKey(),
    jobName: text('job_name').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    status: text('status').notNull(),
    processed: integer('processed').notNull().default(0),
    errorCode: text('error_code'),
  },
  (table) => [check('job_runs_status_check', sql`${table.status} in ('running', 'succeeded', 'failed')`)],
);
