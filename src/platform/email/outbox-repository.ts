import { randomUUID } from 'node:crypto';
import { encryptText } from '../crypto/field-cipher.ts';
import type { Transaction } from '../db/database.ts';
import { emailOutbox } from '../db/schema/index.ts';

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
