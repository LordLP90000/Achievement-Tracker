import type { Kek } from '../../platform/crypto/kek-source.ts';
import { rewrapDataKey } from '../../platform/crypto/key-rotation.ts';
import { inTransaction, type Database } from '../../platform/db/database.ts';
import { storeRewrappedKey, wrappedKeysAfter } from './rewrap-repository.ts';

/** Data keys per transaction: each is one small row, re-wrapped in microseconds. */
export const REWRAP_BATCH_SIZE = 1000;

export interface RewrapKeks {
  readonly current: Kek;
  readonly previous: readonly Kek[];
}

export interface RewrapResult {
  /** Already wrapped by the current KEK, with its label. */
  readonly current: number;
  /** Re-wrapped under the current KEK (or relabelled). */
  readonly rewrapped: number;
  /** No given KEK opens them: left as they are. */
  readonly unknown: number;
}

export interface RewrapOptions {
  /** Data keys per transaction (tests). */
  readonly batchSize?: number;
}

/**
 * Re-wraps every account's data key under the current KEK (KEK rotation, ADR-0020, Q-56): a key the current KEK opens
 * stays, one a previous KEK opens is re-wrapped and stored with the current labels and `rotated_at`, any other is
 * counted and left. Run again, it changes nothing. The data itself is never touched: only the small wrapped keys.
 */
export async function rewrapDataKeys(
  db: Database,
  keks: RewrapKeks,
  now: Date,
  options: RewrapOptions = {},
): Promise<RewrapResult> {
  const batchSize = options.batchSize ?? REWRAP_BATCH_SIZE;
  let totals: RewrapResult = { current: 0, rewrapped: 0, unknown: 0 };
  for (let after: string | undefined; ;) {
    const batch = await inTransaction(db, async (tx) => {
      const keys = await wrappedKeysAfter(tx, after, batchSize);
      let counts: RewrapResult = { current: 0, rewrapped: 0, unknown: 0 };
      for (const { userId, wrapped } of keys) {
        const result = rewrapDataKey(wrapped, userId, keks.current, keks.previous);
        if (result.outcome === 'rewrapped') await storeRewrappedKey(tx, userId, wrapped.blob, result.wrapped, now);
        counts = { ...counts, [result.outcome]: counts[result.outcome] + 1 };
      }
      return { counts, size: keys.length, last: keys.at(-1)?.userId };
    });
    totals = {
      current: totals.current + batch.counts.current,
      rewrapped: totals.rewrapped + batch.counts.rewrapped,
      unknown: totals.unknown + batch.counts.unknown,
    };
    if (batch.size < batchSize) break;
    after = batch.last;
  }
  return totals;
}
