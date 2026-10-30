import { and, eq, gt, lte } from 'drizzle-orm';
import type { Transaction } from '../db/database.ts';
import { transactionLock } from '../db/locks.ts';
import { idempotencyKeys } from '../db/schema/index.ts';

/** Stored responses of create requests (data-model §3.5, ADR-0008); row-level security binds them to the user. */

export interface IdempotencyRecord {
  readonly id: string;
  readonly requestHash: Buffer;
  readonly responseStatus: number;
  readonly responseBodyEnc: Buffer;
}

export interface NewIdempotencyRecord extends IdempotencyRecord {
  readonly userId: string;
  readonly route: string;
  readonly key: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
}

/** Holds back every other request with this key until the transaction ends. */
export function lockIdempotencyKey(tx: Transaction, userId: string, route: string, key: string): Promise<void> {
  return transactionLock(tx, `idempotency:${userId}:${route}:${key}`);
}

/** The record of a key that has not expired at `now`. */
export async function findLiveIdempotencyRecord(
  tx: Transaction,
  userId: string,
  route: string,
  key: string,
  now: Date,
): Promise<IdempotencyRecord | undefined> {
  const [record] = await tx
    .select({
      id: idempotencyKeys.id,
      requestHash: idempotencyKeys.requestHash,
      responseStatus: idempotencyKeys.responseStatus,
      responseBodyEnc: idempotencyKeys.responseBodyEnc,
    })
    .from(idempotencyKeys)
    .where(
      and(
        eq(idempotencyKeys.userId, userId),
        eq(idempotencyKeys.route, route),
        eq(idempotencyKeys.key, key),
        gt(idempotencyKeys.expiresAt, now),
      ),
    );
  return record;
}

/** Stores a record; one that expired for the same key (not yet purged) is replaced, a live one never. */
export async function saveIdempotencyRecord(tx: Transaction, record: NewIdempotencyRecord): Promise<void> {
  const saved = await tx
    .insert(idempotencyKeys)
    .values(record)
    .onConflictDoUpdate({
      target: [idempotencyKeys.userId, idempotencyKeys.route, idempotencyKeys.key],
      set: {
        id: record.id,
        requestHash: record.requestHash,
        responseStatus: record.responseStatus,
        responseBodyEnc: record.responseBodyEnc,
        createdAt: record.createdAt,
        expiresAt: record.expiresAt,
      },
      setWhere: lte(idempotencyKeys.expiresAt, record.createdAt),
    })
    .returning({ id: idempotencyKeys.id });
  if (saved.length !== 1) throw new Error('a live idempotency record exists although the key was locked');
}
