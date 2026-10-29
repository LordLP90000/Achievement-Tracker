import { asc, eq, inArray } from 'drizzle-orm';
import type { Transaction } from '../../platform/db/database.ts';
import { rateLimitBuckets } from '../../platform/db/schema/index.ts';
import type { BucketState } from './policy.ts';

/** `rate_limit_buckets` (UNLOGGED, no user relation): bucket state keyed by a daily HMAC, never a raw subject. */

export interface StoredBucket {
  readonly key: Buffer;
  /** State used when the bucket does not exist yet (a full bucket, no failures). */
  readonly initial: BucketState;
}

/**
 * Creates missing buckets and locks all of them for the rest of the transaction, always in key order so two
 * requests sharing buckets cannot deadlock. Returns each bucket with its current state, in the order given.
 */
export async function lockBuckets<B extends StoredBucket>(
  tx: Transaction,
  buckets: readonly B[],
): Promise<{ readonly bucket: B; readonly state: BucketState }[]> {
  await tx
    .insert(rateLimitBuckets)
    .values(buckets.map(({ key, initial }) => ({ bucketKey: key, ...initial })))
    .onConflictDoNothing({ target: rateLimitBuckets.bucketKey });
  const rows = await tx
    .select({
      key: rateLimitBuckets.bucketKey,
      tokens: rateLimitBuckets.tokens,
      failures: rateLimitBuckets.failures,
      blockedUntil: rateLimitBuckets.blockedUntil,
      updatedAt: rateLimitBuckets.updatedAt,
    })
    .from(rateLimitBuckets)
    .where(
      inArray(
        rateLimitBuckets.bucketKey,
        buckets.map(({ key }) => key),
      ),
    )
    .orderBy(asc(rateLimitBuckets.bucketKey))
    .for('update');
  return buckets.map((bucket) => {
    const row = rows.find((candidate) => candidate.key.equals(bucket.key));
    // Inserted above if missing and locked since: a missing row would be a broken invariant, never a free pass.
    if (row === undefined) throw new Error('rate-limit bucket missing after upsert');
    const state = {
      tokens: row.tokens,
      failures: row.failures,
      blockedUntil: row.blockedUntil,
      updatedAt: row.updatedAt,
    };
    return { bucket, state };
  });
}

export async function saveBucket(tx: Transaction, key: Buffer, state: BucketState): Promise<void> {
  await tx.update(rateLimitBuckets).set(state).where(eq(rateLimitBuckets.bucketKey, key));
}
