import { randomUUID } from 'node:crypto';
import { and, asc, eq, gt, isNull, lte } from 'drizzle-orm';
import { encryptText } from '../crypto/field-cipher.ts';
import type { WrappedKey } from '../crypto/key-wrapper.ts';
import type { Database, Transaction } from '../db/database.ts';
import { increment } from '../db/expressions.ts';
import { emailOutbox, oneTimeTokens, userKeys } from '../db/schema/index.ts';

/**
 * The email outbox (ADR-0009, data-model §3.5): a request only queues an email in its own transaction; the worker
 * sends it. The payload, which holds the recipient address and any token, is encrypted with the user's data key.
 */

export type EmailTemplate =
  | 'verify_email'
  | 'registration_notice'
  | 'password_reset'
  | 'password_changed_notice'
  | 'email_change_verify'
  | 'email_change_notice'
  | 'account_deleted_notice';

export interface EmailPayload {
  readonly to: string;
  readonly locale: string;
  /** Single-use token for the link in the email, if the template has one. */
  readonly token?: string;
}

export interface QueuedEmail {
  readonly userId: string;
  readonly template: EmailTemplate;
  readonly payload: EmailPayload;
}

/** Queues an email for `userId`; the transaction's user context must be `userId` (row-level security). */
export async function enqueueEmail(tx: Transaction, dataKey: Uint8Array, email: QueuedEmail, now: Date): Promise<void> {
  const id = randomUUID();
  const payloadEnc = encryptText(
    dataKey,
    { userId: email.userId, recordId: id, field: 'payload_enc' },
    JSON.stringify(email.payload),
  );
  await tx.insert(emailOutbox).values({
    id,
    userId: email.userId,
    template: email.template,
    payloadEnc,
    nextAttemptAt: now,
    createdAt: now,
  });
}

/** An email the worker holds for one delivery attempt. */
export interface ClaimedEmail {
  readonly id: string;
  readonly userId: string;
  readonly template: EmailTemplate;
  readonly payloadEnc: Buffer;
  /** Attempts so far, this one included. */
  readonly attempts: number;
  /** The user's wrapped data key; missing only if the account lost it. */
  readonly key: WrappedKey | undefined;
}

/**
 * Worker role. Takes the next due email that no other worker holds (`SKIP LOCKED`), counts the attempt and leases
 * the row until `leaseUntil`: if the worker dies while sending, the email is due again when the lease ends.
 */
export async function claimNextEmail(tx: Transaction, now: Date, leaseUntil: Date): Promise<ClaimedEmail | undefined> {
  const [row] = await tx
    .select({
      id: emailOutbox.id,
      userId: emailOutbox.userId,
      template: emailOutbox.template,
      payloadEnc: emailOutbox.payloadEnc,
      attempts: emailOutbox.attempts,
      key: { blob: userKeys.wrappedDek, kekId: userKeys.kekId, kekVersion: userKeys.kekVersion },
    })
    .from(emailOutbox)
    .leftJoin(userKeys, eq(userKeys.userId, emailOutbox.userId))
    .where(and(isNull(emailOutbox.sentAt), isNull(emailOutbox.deadAt), lte(emailOutbox.nextAttemptAt, now)))
    .orderBy(asc(emailOutbox.nextAttemptAt), asc(emailOutbox.createdAt))
    .limit(1)
    .for('update', { of: emailOutbox, skipLocked: true });
  if (row === undefined) return undefined;
  await tx
    .update(emailOutbox)
    .set({ attempts: increment(emailOutbox.attempts), nextAttemptAt: leaseUntil })
    .where(eq(emailOutbox.id, row.id));
  return {
    id: row.id,
    userId: row.userId,
    // The table's check constraint admits only these names.
    template: row.template as EmailTemplate,
    payloadEnc: row.payloadEnc,
    attempts: row.attempts + 1,
    key: row.key ?? undefined,
  };
}

export interface TokenReference {
  readonly userId: string;
  readonly purpose: 'verify_email' | 'change_email' | 'reset_password';
  readonly tokenHash: Buffer;
}

/** Worker role. Whether a single-use token still works: not used, not expired and not replaced by a newer one. */
export async function isOneTimeTokenUsable(db: Database, token: TokenReference, now: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: oneTimeTokens.id })
    .from(oneTimeTokens)
    .where(
      and(
        eq(oneTimeTokens.tokenHash, token.tokenHash),
        eq(oneTimeTokens.userId, token.userId),
        eq(oneTimeTokens.purpose, token.purpose),
        isNull(oneTimeTokens.usedAt),
        gt(oneTimeTokens.expiresAt, now),
      ),
    );
  return row !== undefined;
}

/** Worker role. A sent or outdated email is deleted at once (data-model §3.5). */
export async function deleteEmail(db: Database, id: string): Promise<void> {
  await db.delete(emailOutbox).where(eq(emailOutbox.id, id));
}

/**
 * Worker role. Records a failed attempt: due again at `retryAt`, or a dead letter when `retryAt` is undefined. Only
 * the claim that made the attempt may record it, so a late result cannot overwrite a newer claim.
 */
export async function recordFailedAttempt(
  db: Database,
  email: Pick<ClaimedEmail, 'id' | 'attempts'>,
  errorCode: string,
  now: Date,
  retryAt: Date | undefined,
): Promise<void> {
  await db
    .update(emailOutbox)
    .set(
      retryAt === undefined
        ? { deadAt: now, lastErrorCode: errorCode }
        : { nextAttemptAt: retryAt, lastErrorCode: errorCode },
    )
    .where(and(eq(emailOutbox.id, email.id), eq(emailOutbox.attempts, email.attempts)));
}
