import { and, asc, count, eq, gt, inArray } from 'drizzle-orm';
import type { WrappedKey } from '../../platform/crypto/key-wrapper.ts';
import type { Database, Transaction } from '../../platform/db/database.ts';
import { auditEvents, userKeys, users } from '../../platform/db/schema/index.ts';

/**
 * The incident notice's reads (Q-61, ADR-0021), with the migrator's role: `users` has no row-level security, and
 * migration 0011 gives the migrator policies on `audit_events` and `email_outbox`, which force it.
 */

export interface NoticeRecipient {
  readonly userId: string;
  readonly locale: string;
  readonly emailEnc: Buffer;
  /** Missing only if the account lost its data key. */
  readonly wrapped: WrappedKey | undefined;
}

/** Up to `limit` accounts after `after`, in ID order, with their address and their data key. */
export async function recipientsAfter(
  tx: Transaction,
  after: string | undefined,
  limit: number,
): Promise<NoticeRecipient[]> {
  const rows = await tx
    .select({
      userId: users.id,
      locale: users.locale,
      emailEnc: users.emailEnc,
      key: { blob: userKeys.wrappedDek, kekId: userKeys.kekId, kekVersion: userKeys.kekVersion },
    })
    .from(users)
    .leftJoin(userKeys, eq(userKeys.userId, users.id))
    .where(after === undefined ? undefined : gt(users.id, after))
    .orderBy(asc(users.id))
    .limit(limit);
  return rows.map(({ key, ...row }) => ({ ...row, wrapped: key ?? undefined }));
}

const notifiedOf = (incident: string) =>
  and(eq(auditEvents.eventType, 'incident_notified'), eq(auditEvents.metadata, { incident }));

/** The accounts among `userIds` that already got this incident's notice: each has its `incident_notified` event. */
export async function notifiedAmong(
  tx: Transaction,
  incident: string,
  userIds: readonly string[],
): Promise<ReadonlySet<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await tx
    .selectDistinct({ userId: auditEvents.userId })
    .from(auditEvents)
    .where(and(notifiedOf(incident), inArray(auditEvents.userId, [...userIds])));
  return new Set(rows.map((row) => row.userId).filter((userId): userId is string => userId !== null));
}

/** How many accounts there are with each locale. */
export async function accountsByLocale(db: Database): Promise<{ readonly locale: string; readonly count: number }[]> {
  return db.select({ locale: users.locale, count: count() }).from(users).groupBy(users.locale);
}

/** How many accounts already got this incident's notice: an account's audit events are deleted with it. */
export async function notifiedCount(db: Database, incident: string): Promise<number> {
  const [row] = await db.select({ count: count() }).from(auditEvents).where(notifiedOf(incident));
  return row?.count ?? 0;
}
