import { and, desc, eq, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { Transaction } from '../../platform/db/database.ts';
import { consents } from '../../platform/db/schema/index.ts';

/** Versioned consents (data-model §3.2): row-level security binds them to the user; history is kept. */

export type ConsentType = 'goal_content';

export interface ConsentRecord {
  readonly type: ConsentType;
  readonly version: string;
  readonly grantedAt: Date;
  readonly withdrawnAt: Date | null;
}

const columns = {
  type: consents.type,
  version: consents.version,
  grantedAt: consents.grantedAt,
  withdrawnAt: consents.withdrawnAt,
};

const asRecord = (row: { type: string; version: string; grantedAt: Date; withdrawnAt: Date | null }) =>
  ({ ...row, type: row.type as ConsentType }) satisfies ConsentRecord;

export async function listConsents(tx: Transaction, userId: string): Promise<ConsentRecord[]> {
  const rows = await tx
    .select(columns)
    .from(consents)
    .where(eq(consents.userId, userId))
    .orderBy(desc(consents.grantedAt), desc(consents.id));
  return rows.map(asRecord);
}

/** Fails with a unique violation while a consent of the type is active (partial unique index). */
export async function insertConsent(
  tx: Transaction,
  consent: { readonly userId: string; readonly type: ConsentType; readonly version: string },
  now: Date,
): Promise<ConsentRecord> {
  await tx.insert(consents).values({ id: randomUUID(), ...consent, grantedAt: now });
  return { type: consent.type, version: consent.version, grantedAt: now, withdrawnAt: null };
}

/** Withdraws the active consent of the type; false when there is none. */
export async function withdrawConsent(tx: Transaction, userId: string, type: ConsentType, now: Date): Promise<boolean> {
  const withdrawn = await tx
    .update(consents)
    .set({ withdrawnAt: now })
    .where(and(eq(consents.userId, userId), eq(consents.type, type), isNull(consents.withdrawnAt)))
    .returning({ type: consents.type });
  return withdrawn.length === 1;
}
