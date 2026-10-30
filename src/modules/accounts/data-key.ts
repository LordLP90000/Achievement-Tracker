import type { DataKeys } from '../../platform/crypto/data-keys.ts';
import { setUserContext, type Transaction } from '../../platform/db/database.ts';
import { requireVersionedKey } from './repository.ts';

/** The account's data key during one unit of work, with the version that encrypted rows record (ADR-0006). */
export interface UserDataKey {
  readonly key: Uint8Array;
  readonly version: number;
}

/** Binds the transaction to the account (RLS) and runs `work` with its data key, which is wiped afterwards. */
export async function withUserDataKey<T>(
  tx: Transaction,
  dataKeys: DataKeys,
  userId: string,
  work: (dataKey: UserDataKey) => Promise<T>,
): Promise<T> {
  await setUserContext(tx, userId);
  const stored = await requireVersionedKey(tx, userId);
  return dataKeys.withKey(userId, stored.wrapped, (key) => work({ key, version: stored.version }));
}
