import type { Transaction } from '../../platform/db/database.ts';
import type { ScheduledJob } from '../../platform/jobs/scheduler.ts';
import { REFRESH_TOKEN_LIFETIME_MS } from '../sessions/service.ts';
import {
  deleteAuditEvents,
  deleteDeadLetters,
  deleteEndedSessions,
  deleteExpiredSessionTokens,
  deleteJobRuns,
  deleteRateLimitBuckets,
  deleteSpentOneTimeTokens,
  deleteTombstones,
  deleteUnverifiedAccounts,
} from './retention-repository.ts';

/**
 * Retention periods (data-model §3, data-inventory.yaml) enforced by hourly purge jobs in the worker. Deletes run in
 * batches, so no statement touches more than `batchSize` rows; a backlog beyond `maxBatches` is left to the next run.
 */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const RETENTION = Object.freeze({
  /** S-12: an address nobody verified is not kept. */
  unverifiedAccountMs: 7 * DAY_MS,
  /** After revocation, absolute expiry or the last possible refresh. */
  endedSessionMs: 7 * DAY_MS,
  auditEventMs: 90 * DAY_MS,
  rateLimitBucketMs: 24 * HOUR_MS,
  deadLetterMs: 7 * DAY_MS,
  /** Q-13, ADR-0006: tombstones outlive the backups they are replayed against after a restore. */
  tombstoneMs: 35 * DAY_MS,
  jobRunMs: 30 * DAY_MS,
});

export const RETENTION_INTERVAL_MS = HOUR_MS;

export interface RetentionOptions {
  readonly batchSize?: number;
  readonly maxBatches?: number;
}

type Purge = (tx: Transaction, now: Date, limit: number) => Promise<number>;

const before = (now: Date, ms: number): Date => new Date(now.getTime() - ms);

export function retentionJobs(options: RetentionOptions = {}): ScheduledJob[] {
  const batchSize = options.batchSize ?? 1000;
  const maxBatches = options.maxBatches ?? 100;
  const job = (name: string, purge: Purge): ScheduledJob => ({
    name,
    intervalMs: RETENTION_INTERVAL_MS,
    async run(tx, now) {
      let total = 0;
      for (let batch = 0; batch < maxBatches; batch += 1) {
        const deleted = await purge(tx, now, batchSize);
        total += deleted;
        if (deleted < batchSize) break;
      }
      return total;
    },
  });
  return [
    job('purge_unverified_accounts', (tx, now, limit) =>
      deleteUnverifiedAccounts(tx, before(now, RETENTION.unverifiedAccountMs), limit),
    ),
    job('purge_one_time_tokens', deleteSpentOneTimeTokens),
    job('purge_session_tokens', deleteExpiredSessionTokens),
    job('purge_sessions', (tx, now, limit) =>
      deleteEndedSessions(
        tx,
        {
          revokedBefore: before(now, RETENTION.endedSessionMs),
          expiredBefore: before(now, RETENTION.endedSessionMs),
          lastUsedBefore: before(now, REFRESH_TOKEN_LIFETIME_MS + RETENTION.endedSessionMs),
        },
        limit,
      ),
    ),
    job('purge_audit_events', (tx, now, limit) => deleteAuditEvents(tx, before(now, RETENTION.auditEventMs), limit)),
    job('purge_rate_limit_buckets', (tx, now, limit) =>
      deleteRateLimitBuckets(tx, before(now, RETENTION.rateLimitBucketMs), limit),
    ),
    job('purge_dead_letters', (tx, now, limit) => deleteDeadLetters(tx, before(now, RETENTION.deadLetterMs), limit)),
    job('purge_tombstones', (tx, now, limit) => deleteTombstones(tx, before(now, RETENTION.tombstoneMs), limit)),
    job('purge_job_runs', (tx, now, limit) => deleteJobRuns(tx, before(now, RETENTION.jobRunMs), limit)),
  ];
}
