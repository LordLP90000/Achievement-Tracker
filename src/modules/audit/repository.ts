import { randomUUID } from 'node:crypto';
import type { Transaction } from '../../platform/db/database.ts';
import { auditEvents } from '../../platform/db/schema/index.ts';

/** Security audit events with minimal data (R-LOG-03): no addresses, no content, networks only (C8). */

export type AuditEventType = 'email_verified';

export interface AuditEvent {
  /** `null` only for events about unknown accounts; otherwise the transaction's user context must be this user. */
  readonly userId: string | null;
  readonly eventType: AuditEventType;
  readonly outcome: 'success' | 'failure';
  readonly ipPrefix: string | null;
  readonly client: 'ios' | 'android' | null;
}

/** Appends an event. The API may only insert (no SELECT grant), so nothing is read back. */
export async function recordAuditEvent(tx: Transaction, event: AuditEvent, now: Date): Promise<void> {
  await tx.insert(auditEvents).values({ id: randomUUID(), ...event, createdAt: now });
}
