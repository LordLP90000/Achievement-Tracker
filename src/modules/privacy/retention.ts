import type { Transaction } from '../../platform/db/database.ts';
import type { ScheduledJob } from '../../platform/jobs/scheduler.ts';
import { DELETION_GRACE_MS, REFRESH_TOKEN_LIFETIME_MS } from '../sessions/service.ts';
import {
  deleteAuditEvents,
  deleteDeactivatedAccounts,
  deleteDeadLetters,
  deleteEndedSessions,
  deleteExpiredIdempotencyKeys,
  deleteExpiredSecondFactorChallenges,
  deleteExpiredSessionTokens,
  deleteExpiredWebauthnChallenges,
  deleteJobRuns,
  deletePendingTotpSecrets,
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
  /** R-PRIV-06: from the deletion request to the hard delete; login refuses the account from the same instant. */
  deactivatedAccountMs: DELETION_GRACE_MS,
  /** After revocation, absolute expiry or the last possible refresh. */
  endedSessionMs: 7 * DAY_MS,
  /** Q-53: a TOTP secret not confirmed within a day was abandoned. */
  pendingTotpSecretMs: 24 * HOUR_MS,
  auditEventMs: 90 * DAY_MS,
  rateLimitBucketMs: 24 * HOUR_MS,
  deadLetterMs: 7 * DAY_MS,
  /** Q-13, ADR-0006: tombstones outlive the backups they are replayed against after a restore. */
  tombstoneMs: 35 * DAY_MS,
  jobRunMs: 30 * DAY_MS,
});

export const RETENTION_INTERVAL_MS = HOUR_MS;

export interface RetentionOptions {
  /** Overrides every job's batch size (tests). */
  readonly batchSize?: number;
  /** Overrides every job's batches per run (tests). */
  readonly maxBatches?: number;
}

interface Batches {
  readonly batchSize: number;
  readonly maxBatches: number;
}

/**
 * Plain rows by the thousand. An account takes everything it owns with it — its whole goal archive — so a run deletes
 * at most 1 000 accounts, 100 per statement, and its transaction stays bounded; the rest follows an hour later.
 */
const ROWS: Batches = { batchSize: 1000, maxBatches: 100 };
const ACCOUNTS: Batches = { batchSize: 100, maxBatches: 10 };

type Purge = (tx: Transaction, now: Date, limit: number) => Promise<number>;

const before = (now: Date, ms: number): Date => new Date(now.getTime() - ms);

export function retentionJobs(options: RetentionOptions = {}): ScheduledJob[] {
  const job = (name: string, purge: Purge, defaults: Batches = ROWS): ScheduledJob => {
    const batchSize = options.batchSize ?? defaults.batchSize;
    const maxBatches = options.maxBatches ?? defaults.maxBatches;
    return {
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
    };
  };
  return [
    job('purge_unverified_accounts', (tx, now, limit) =>
      deleteUnverifiedAccounts(tx, before(now, RETENTION.unverifiedAccountMs), limit),
    ),
    job(
      'purge_deleted_accounts',
      (tx, now, limit) =>
        deleteDeactivatedAccounts(tx, { requestedBefore: before(now, RETENTION.deactivatedAccountMs), now }, limit),
      ACCOUNTS,
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
    job('purge_webauthn_challenges', deleteExpiredWebauthnChallenges),
    job('purge_second_factor_challenges', deleteExpiredSecondFactorChallenges),
    job('purge_pending_totp_secrets', (tx, now, limit) =>
      deletePendingTotpSecrets(tx, before(now, RETENTION.pendingTotpSecretMs), limit),
    ),
    job('purge_audit_events', (tx, now, limit) => deleteAuditEvents(tx, before(now, RETENTION.auditEventMs), limit)),
    job('purge_rate_limit_buckets', (tx, now, limit) =>
      deleteRateLimitBuckets(tx, before(now, RETENTION.rateLimitBucketMs), limit),
    ),
    job('purge_idempotency_keys', deleteExpiredIdempotencyKeys),
    job('purge_dead_letters', (tx, now, limit) => deleteDeadLetters(tx, before(now, RETENTION.deadLetterMs), limit)),
    job('purge_tombstones', (tx, now, limit) => deleteTombstones(tx, before(now, RETENTION.tombstoneMs), limit)),
    job('purge_job_runs', (tx, now, limit) => deleteJobRuns(tx, before(now, RETENTION.jobRunMs), limit)),
  ];
}
