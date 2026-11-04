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
  secondFactorChallenges,
  sessions,
  sessionTokens,
  totpSecrets,
  users,
  webauthnChallenges,
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

/**
 * Accounts whose deletion was requested at or before `requestedBefore` (R-PRIV-06), each with everything it owns —
 * its wrapped data key too (crypto-shredding). The request time is checked again as each row is deleted, so an
 * account reactivated meanwhile by a login stays; only the accounts actually deleted get a tombstone, in the same
 * transaction (Q-13).
 */
export async function deleteDeactivatedAccounts(
  tx: Transaction,
  cutoff: { readonly requestedBefore: Date; readonly now: Date },
  limit: number,
): Promise<number> {
  const due = lte(users.deactivatedAt, cutoff.requestedBefore);
  const batch = tx.select({ id: users.id }).from(users).where(due).limit(limit);
  const deleted = await tx
    .delete(users)
    .where(and(inArray(users.id, batch), due))
    .returning({ id: users.id });
  if (deleted.length > 0) {
    await tx
      .insert(deletedUserTombstones)
      .values(deleted.map(({ id }) => ({ userId: id, deletedAt: cutoff.now })))
      .onConflictDoNothing();
  }
  return deleted.length;
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

/** WebAuthn challenges whose 5 minutes are over (ADR-0019); a used one was deleted at once. */
export function deleteExpiredWebauthnChallenges(tx: Transaction, now: Date, limit: number): Promise<number> {
  return deleteBatch(tx, webauthnChallenges, webauthnChallenges.id, lte(webauthnChallenges.expiresAt, now), limit);
}

/** Second-factor tokens whose 5 minutes are over (ADR-0019); a used one was deleted at once. */
export function deleteExpiredSecondFactorChallenges(tx: Transaction, now: Date, limit: number): Promise<number> {
  return deleteBatch(
    tx,
    secondFactorChallenges,
    secondFactorChallenges.id,
    lte(secondFactorChallenges.expiresAt, now),
    limit,
  );
}

/**
 * TOTP secrets never confirmed, created at or before `createdBefore` (Q-53). The condition is checked again as each
 * row is deleted, so a secret confirmed meanwhile stays; the worker's policy hides confirmed ones as well.
 */
export async function deletePendingTotpSecrets(tx: Transaction, createdBefore: Date, limit: number): Promise<number> {
  const due = and(isNull(totpSecrets.enabledAt), lte(totpSecrets.createdAt, createdBefore));
  const batch = tx.select({ userId: totpSecrets.userId }).from(totpSecrets).where(due).limit(limit);
  const deleted = await tx
    .delete(totpSecrets)
    .where(and(inArray(totpSecrets.userId, batch), due))
    .returning({ userId: totpSecrets.userId });
  return deleted.length;
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
