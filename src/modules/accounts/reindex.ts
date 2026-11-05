import { DecryptionError } from '../../platform/crypto/aead.ts';
import { reindexBlindIndex, type Reindex } from '../../platform/crypto/blind-index.ts';
import type { DataKeys } from '../../platform/crypto/data-keys.ts';
import { decryptText } from '../../platform/crypto/field-cipher.ts';
import { UnknownKekError } from '../../platform/crypto/key-wrapper.ts';
import { inTransaction, type Database, type Transaction } from '../../platform/db/database.ts';
import { emailField } from './account-mail.ts';
import {
  addressesAfter,
  pendingAddressesOf,
  storeAddressIndex,
  storePendingIndex,
  type IndexedAddress,
  type PendingAddress,
} from './reindex-repository.ts';

/** Accounts per transaction: each decrypts one or two addresses with its data key. */
export const REINDEX_BATCH_SIZE = 500;

export interface BlindIndexKeys {
  readonly current: Uint8Array;
  readonly previous: Uint8Array | undefined;
}

export interface ReindexResult {
  /** Already under the current key. */
  readonly current: number;
  /** Indexed again under the current key. */
  readonly reindexed: number;
  /** Under neither key, or not readable with the current KEK: left as they are. */
  readonly unknown: number;
}

export interface ReindexOptions {
  /** Accounts per transaction (tests). */
  readonly batchSize?: number;
}

type Outcome = Reindex['outcome'];

const tally = (outcomes: readonly Outcome[]): ReindexResult => ({
  current: outcomes.filter((outcome) => outcome === 'current').length,
  reindexed: outcomes.filter((outcome) => outcome === 'reindexed').length,
  unknown: outcomes.filter((outcome) => outcome === 'unknown').length,
});

/** The account's address and its pending new address, each indexed under the current key. */
async function reindexAccount(
  tx: Transaction,
  dataKey: Uint8Array,
  account: IndexedAddress,
  pending: readonly PendingAddress[],
  keys: BlindIndexKeys,
): Promise<Outcome[]> {
  const address = decryptText(dataKey, emailField(account.userId), account.emailEnc);
  const own = reindexBlindIndex(account.emailBlindIndex, address, keys.current, keys.previous);
  if (own.outcome === 'reindexed') await storeAddressIndex(tx, account.userId, account.emailBlindIndex, own.blindIndex);
  let outcomes: Outcome[] = [own.outcome];
  for (const change of pending) {
    const context = { userId: change.userId, recordId: change.id, field: 'new_email_enc' };
    const newAddress = decryptText(dataKey, context, change.newEmailEnc);
    const result = reindexBlindIndex(change.newEmailBlindIndex, newAddress, keys.current, keys.previous);
    if (result.outcome === 'reindexed') {
      await storePendingIndex(tx, change.id, change.newEmailBlindIndex, result.blindIndex);
    }
    outcomes = [...outcomes, result.outcome];
  }
  return outcomes;
}

/**
 * Indexes every address again under the current blind-index key (ADR-0020, RR-3): each account's address, and the new
 * address of every pending email change, is decrypted with the account's data key; an index under the current key
 * stays, one under the previous key is replaced, and any other is counted and left. An account whose data key the
 * KEK does not open counts as unknown, and the walk goes on. Run again, it changes nothing. Run it only while the API
 * is stopped: with the old key, the API would let a second account register an address that is already taken.
 */
export async function reindexEmailBlindIndexes(
  db: Database,
  dataKeys: DataKeys,
  keys: BlindIndexKeys,
  options: ReindexOptions = {},
): Promise<ReindexResult> {
  const batchSize = options.batchSize ?? REINDEX_BATCH_SIZE;
  let outcomes: Outcome[] = [];
  for (let after: string | undefined; ;) {
    const batch = await inTransaction(db, async (tx) => {
      const accounts = await addressesAfter(tx, after, batchSize);
      const pending = await pendingAddressesOf(
        tx,
        accounts.map((account) => account.userId),
      );
      let found: Outcome[] = [];
      for (const account of accounts) {
        const own = pending.filter((change) => change.userId === account.userId);
        try {
          const results = await dataKeys.withKey(account.userId, account.wrapped, (dataKey) =>
            reindexAccount(tx, dataKey, account, own, keys),
          );
          found = [...found, ...results];
        } catch (error) {
          if (!(error instanceof DecryptionError || error instanceof UnknownKekError)) throw error;
          found = [...found, 'unknown'];
        }
      }
      return { found, size: accounts.length, last: accounts.at(-1)?.userId };
    });
    outcomes = [...outcomes, ...batch.found];
    if (batch.size < batchSize) break;
    after = batch.last;
  }
  return tally(outcomes);
}
