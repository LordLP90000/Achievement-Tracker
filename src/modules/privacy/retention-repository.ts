import { and, inArray, isNull, lte, or, type SQL } from 'drizzle-orm';
import type { PgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Transaction } from '../../platform/db/database.ts';
import {
  auditEvents,
  deletedUserTombstones,
  emailOutbox,
  idempotencyKeys,
  jobRuns,
  oneTimeTokens,
  rateLimitBuckets,
  sessions,
  sessionTokens,
  users,
} from '../../platform/db/schema/index.ts';

/**
 * Retention deletes (data-model §3, data-inventory.yaml), worker role. Each call deletes at most `limit` rows that
 * are past their retention and returns how many it deleted; deleting a user cascades to everything the user owns.
 */

async function deleteBatch(tx: Transaction, table: PgTable, key: PgColumn, due: SQL | undefined, limit: number) {
  const batch = tx.select({ key }).from(table).where(due).limit(limit);
  const deleted = await tx.delete(table).where(inArray(key, batch)).returning({ key });
  return deleted.length;
}

/** Accounts whose address was never verified, created at or before `createdBefore` (S-12). */
export function deleteUnverifiedAccounts(tx: Transaction, createdBefore: Date, limit: number): Promise<number> {
  return deleteBatch(
    tx,
    users,
    users.id,
    and(isNull(users.emailVerifiedAt), lte(users.createdAt, createdBefore)),
    limit,
  );
}

/** One-time tokens that were used or have expired (R-AUTH-03). */
export function deleteSpentOneTimeTokens(tx: Transaction, now: Date, limit: number): Promise<number> {
  return deleteBatch(
    tx,
    oneTimeTokens,
    oneTimeTokens.id,
    or(lte(oneTimeTokens.usedAt, now), lte(oneTimeTokens.expiresAt, now)),
    limit,
  );
}

/**
 * Token generations whose refresh token has expired. Rotated generations stay until then, so a replayed refresh
 * token is still recognised as reuse (R-AUTH-04); revoking a session deletes its tokens at once.
 */
export function deleteExpiredSessionTokens(tx: Transaction, now: Date, limit: number): Promise<number> {
  return deleteBatch(tx, sessionTokens, sessionTokens.id, lte(sessionTokens.refreshExpiresAt, now), limit);
}

export interface EndedSessionCutoffs {
  readonly revokedBefore: Date;
  readonly expiredBefore: Date;
  /** Sessions last used before this can no longer be refreshed and have been dead for the retention period. */
  readonly lastUsedBefore: Date;
}

/** Sessions revoked, past their absolute lifetime or idle beyond the refresh lifetime, each for the retention period. */
export function deleteEndedSessions(tx: Transaction, cutoffs: EndedSessionCutoffs, limit: number): Promise<number> {
  return deleteBatch(
    tx,
    sessions,
    sessions.id,
    or(
      lte(sessions.revokedAt, cutoffs.revokedBefore),
      lte(sessions.absoluteExpiresAt, cutoffs.expiredBefore),
      lte(sessions.lastUsedAt, cutoffs.lastUsedBefore),
    ),
    limit,
  );
}

export function deleteAuditEvents(tx: Transaction, createdBefore: Date, limit: number): Promise<number> {
  return deleteBatch(tx, auditEvents, auditEvents.id, lte(auditEvents.createdAt, createdBefore), limit);
}

export function deleteRateLimitBuckets(tx: Transaction, updatedBefore: Date, limit: number): Promise<number> {
  return deleteBatch(
    tx,
    rateLimitBuckets,
    rateLimitBuckets.bucketKey,
    lte(rateLimitBuckets.updatedAt, updatedBefore),
    limit,
  );
}

/** Stored responses whose 24 hours are over (ADR-0008): their keys may already be reused. */
export function deleteExpiredIdempotencyKeys(tx: Transaction, now: Date, limit: number): Promise<number> {
  return deleteBatch(tx, idempotencyKeys, idempotencyKeys.id, lte(idempotencyKeys.expiresAt, now), limit);
}

/** Dead letters only: an email that is still waiting is never deleted by retention. */
export function deleteDeadLetters(tx: Transaction, deadBefore: Date, limit: number): Promise<number> {
  return deleteBatch(tx, emailOutbox, emailOutbox.id, lte(emailOutbox.deadAt, deadBefore), limit);
}

export function deleteTombstones(tx: Transaction, deletedBefore: Date, limit: number): Promise<number> {
  return deleteBatch(
    tx,
    deletedUserTombstones,
    deletedUserTombstones.userId,
    lte(deletedUserTombstones.deletedAt, deletedBefore),
    limit,
  );
}

export function deleteJobRuns(tx: Transaction, startedBefore: Date, limit: number): Promise<number> {
  return deleteBatch(tx, jobRuns, jobRuns.id, lte(jobRuns.startedAt, startedBefore), limit);
}
