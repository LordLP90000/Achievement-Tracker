import { and, asc, eq, gt, inArray, isNotNull } from 'drizzle-orm';
import type { WrappedKey } from '../../platform/crypto/key-wrapper.ts';
import type { Transaction } from '../../platform/db/database.ts';
import { oneTimeTokens, userKeys, users } from '../../platform/db/schema/index.ts';

/** The stored blind indexes a blind-index key rotation re-computes (ADR-0020), with the migrator's role. */

export interface IndexedAddress {
  readonly userId: string;
  readonly emailEnc: Buffer;
  readonly emailBlindIndex: Buffer;
  readonly wrapped: WrappedKey;
}

/** The new address of an email change waiting for its confirmation. */
export interface PendingAddress {
  readonly id: string;
  readonly userId: string;
  readonly newEmailEnc: Buffer;
  readonly newEmailBlindIndex: Buffer;
}

/** The next `limit` accounts after `after`, in order, with their address and data key. */
export async function addressesAfter(
  tx: Transaction,
  after: string | undefined,
  limit: number,
): Promise<IndexedAddress[]> {
  const rows = await tx
    .select({
      userId: users.id,
      emailEnc: users.emailEnc,
      emailBlindIndex: users.emailBlindIndex,
      blob: userKeys.wrappedDek,
      kekId: userKeys.kekId,
      kekVersion: userKeys.kekVersion,
    })
    .from(users)
    .innerJoin(userKeys, eq(userKeys.userId, users.id))
    .where(after === undefined ? undefined : gt(users.id, after))
    .orderBy(asc(users.id))
    .limit(limit);
  return rows.map(({ blob, kekId, kekVersion, ...address }) => ({ ...address, wrapped: { blob, kekId, kekVersion } }));
}

export async function pendingAddressesOf(tx: Transaction, userIds: readonly string[]): Promise<PendingAddress[]> {
  if (userIds.length === 0) return [];
  const rows = await tx
    .select({
      id: oneTimeTokens.id,
      userId: oneTimeTokens.userId,
      newEmailEnc: oneTimeTokens.newEmailEnc,
      newEmailBlindIndex: oneTimeTokens.newEmailBlindIndex,
    })
    .from(oneTimeTokens)
    .where(
      and(
        inArray(oneTimeTokens.userId, [...userIds]),
        isNotNull(oneTimeTokens.newEmailEnc),
        isNotNull(oneTimeTokens.newEmailBlindIndex),
      ),
    );
  return rows.flatMap(({ newEmailEnc, newEmailBlindIndex, ...pending }) =>
    newEmailEnc === null || newEmailBlindIndex === null ? [] : [{ ...pending, newEmailEnc, newEmailBlindIndex }],
  );
}

/** Stores the account's new blind index, only over the one it replaces. */
export async function storeAddressIndex(
  tx: Transaction,
  userId: string,
  replaced: Buffer,
  blindIndex: Buffer,
): Promise<void> {
  await tx
    .update(users)
    .set({ emailBlindIndex: blindIndex })
    .where(and(eq(users.id, userId), eq(users.emailBlindIndex, replaced)));
}

/** Stores the pending new address's blind index, only over the one it replaces. */
export async function storePendingIndex(
  tx: Transaction,
  id: string,
  replaced: Buffer,
  blindIndex: Buffer,
): Promise<void> {
  await tx
    .update(oneTimeTokens)
    .set({ newEmailBlindIndex: blindIndex })
    .where(and(eq(oneTimeTokens.id, id), eq(oneTimeTokens.newEmailBlindIndex, replaced)));
}
