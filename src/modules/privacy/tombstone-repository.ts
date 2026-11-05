import { eq, inArray } from 'drizzle-orm';
import { inBatches } from '../../platform/db/batches.ts';
import type { Transaction } from '../../platform/db/database.ts';
import { deletedUserTombstones, users } from '../../platform/db/schema/index.ts';

/** Tombstones of deleted accounts (Q-13): read from the database a restore replaced, replayed in the restored one. */

export interface Tombstone {
  readonly userId: string;
  readonly deletedAt: Date;
}

export function readTombstones(tx: Transaction): Promise<Tombstone[]> {
  return tx
    .select({ userId: deletedUserTombstones.userId, deletedAt: deletedUserTombstones.deletedAt })
    .from(deletedUserTombstones)
    .orderBy(deletedUserTombstones.deletedAt, deletedUserTombstones.userId);
}

/** Inserts the tombstones this database lacks, each with its date; returns how many it inserted. */
export async function insertTombstones(tx: Transaction, tombstones: readonly Tombstone[]): Promise<number> {
  let inserted = 0;
  for (const batch of inBatches(tombstones)) {
    const rows = await tx
      .insert(deletedUserTombstones)
      .values(batch)
      .onConflictDoNothing()
      .returning({ userId: deletedUserTombstones.userId });
    inserted += rows.length;
  }
  return inserted;
}

/** Deletes up to `limit` accounts that a tombstone names, each with everything it owns; returns how many. */
export async function deleteTombstonedAccounts(tx: Transaction, limit: number): Promise<number> {
  const named = tx
    .select({ id: users.id })
    .from(users)
    .innerJoin(deletedUserTombstones, eq(deletedUserTombstones.userId, users.id))
    .limit(limit);
  const deleted = await tx.delete(users).where(inArray(users.id, named)).returning({ id: users.id });
  return deleted.length;
}
