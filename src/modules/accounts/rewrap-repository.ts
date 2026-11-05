import { and, asc, eq, gt } from 'drizzle-orm';
import type { WrappedKey } from '../../platform/crypto/key-wrapper.ts';
import type { Transaction } from '../../platform/db/database.ts';
import { userKeys } from '../../platform/db/schema/index.ts';

/** The wrapped data keys a KEK rotation re-wraps (ADR-0020), with the migrator's role while the processes are stopped. */

export interface StoredKey {
  readonly userId: string;
  readonly wrapped: WrappedKey;
}

/** The next `limit` wrapped data keys after the account `after`, in order. */
export async function wrappedKeysAfter(
  tx: Transaction,
  after: string | undefined,
  limit: number,
): Promise<StoredKey[]> {
  const rows = await tx
    .select({
      userId: userKeys.userId,
      blob: userKeys.wrappedDek,
      kekId: userKeys.kekId,
      kekVersion: userKeys.kekVersion,
    })
    .from(userKeys)
    .where(after === undefined ? undefined : gt(userKeys.userId, after))
    .orderBy(asc(userKeys.userId))
    .limit(limit);
  return rows.map(({ userId, ...wrapped }) => ({ userId, wrapped }));
}

/** Stores the re-wrapped key, only over the one it replaces; returns whether it did. */
export async function storeRewrappedKey(
  tx: Transaction,
  userId: string,
  replaced: Buffer,
  wrapped: WrappedKey,
  now: Date,
): Promise<boolean> {
  const stored = await tx
    .update(userKeys)
    .set({ wrappedDek: wrapped.blob, kekId: wrapped.kekId, kekVersion: wrapped.kekVersion, rotatedAt: now })
    .where(and(eq(userKeys.userId, userId), eq(userKeys.wrappedDek, replaced)))
    .returning({ userId: userKeys.userId });
  return stored.length === 1;
}
