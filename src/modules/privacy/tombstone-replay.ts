import { inReadOnlyTransaction, inTransaction, type Database } from '../../platform/db/database.ts';
import { deleteTombstonedAccounts, insertTombstones, readTombstones } from './tombstone-repository.ts';

/** Accounts per statement and transaction: each takes everything it owns with it, as in the hourly hard delete. */
export const REPLAY_BATCH_SIZE = 100;

export interface ReplayResult {
  /** Tombstones of the replaced database that the restored one did not hold yet. */
  readonly imported: number;
  /** Accounts deleted because a tombstone names them. */
  readonly deleted: number;
}

export interface ReplayOptions {
  /** Accounts per transaction (tests). */
  readonly batchSize?: number;
}

/**
 * Replays tombstones after a backup restore (Q-13, ADR-0006, ADR-0020). The restored database may hold accounts that
 * were deleted after the backup was taken; the database the restore replaced (`replaced`, read only) holds their
 * tombstones. They are taken over with their dates, so each still expires 35 days after its deletion, and every
 * account a tombstone names is deleted with everything it owns, `batchSize` per transaction, until none is left.
 * Without `replaced`, the restored database's own tombstones are replayed, which finishes a run that stopped after
 * taking them over. Running it again changes nothing.
 */
export async function replayTombstones(
  restored: Database,
  replaced: Database | undefined,
  options: ReplayOptions = {},
): Promise<ReplayResult> {
  const batchSize = options.batchSize ?? REPLAY_BATCH_SIZE;
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new RangeError('a batch holds at least one account');
  const tombstones = replaced === undefined ? [] : await inReadOnlyTransaction(replaced, readTombstones);
  const imported = await inTransaction(restored, (tx) => insertTombstones(tx, tombstones));
  let deleted = 0;
  let batch: number;
  do {
    batch = await inTransaction(restored, (tx) => deleteTombstonedAccounts(tx, batchSize));
    deleted += batch;
  } while (batch === batchSize);
  return { imported, deleted };
}
