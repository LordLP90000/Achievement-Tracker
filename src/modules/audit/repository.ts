import { randomUUID } from 'node:crypto';
import { and, eq, gt } from 'drizzle-orm';
import type { Transaction } from '../../platform/db/database.ts';
import { auditEvents } from '../../platform/db/schema/index.ts';

/** Security audit events with minimal data (R-LOG-03): no addresses, no content, networks only (C8). */

export type AuditEventType =
  | 'email_verified'
  | 'login_succeeded'
  | 'login_failed'
  | 'account_reactivated'
  | 'session_revoked'
  | 'refresh_reuse_detected'
  | 'logout'
  | 'reauth_succeeded'
  | 'reauth_failed'
  | 'password_changed'
  | 'password_reset_requested'
  | 'password_reset_completed'
  | 'email_change_requested'
  | 'email_changed'
  | 'consent_granted'
  | 'consent_withdrawn'
  | 'export_requested'
  | 'account_deleted'
  | 'totp_enabled'
  | 'totp_disabled'
  | 'recovery_codes_generated'
  | 'recovery_code_used'
  | 'second_factor_failed';

export interface AuditEvent {
  /** `null` only for events about unknown accounts; otherwise the transaction's user context must be this user. */
  readonly userId: string | null;
  readonly eventType: AuditEventType;
  readonly outcome: 'success' | 'failure';
  readonly ipPrefix: string | null;
  readonly client: 'ios' | 'android' | null;
  readonly sessionId?: string;
  /** Short codes only (e.g. `reason: session_limit`), never user input. */
  readonly metadata?: Readonly<Record<string, string>>;
}

/** Appends an event in the transaction of the change it records, so both commit or neither does. */
export async function recordAuditEvent(tx: Transaction, event: AuditEvent, now: Date): Promise<void> {
  await tx.insert(auditEvents).values({ id: randomUUID(), ...event, createdAt: now });
}

/**
 * When the user's events of a type happened after `since`. The API reads only the user in context (RLS,
 * migration 0008): the export shows them, and counts its own for its rolling limit (D-09).
 */
export async function auditEventTimes(
  tx: Transaction,
  userId: string,
  eventType: AuditEventType,
  since: Date,
): Promise<Date[]> {
  const rows = await tx
    .select({ createdAt: auditEvents.createdAt })
    .from(auditEvents)
    .where(and(eq(auditEvents.userId, userId), eq(auditEvents.eventType, eventType), gt(auditEvents.createdAt, since)));
  return rows.map((row) => row.createdAt);
}
