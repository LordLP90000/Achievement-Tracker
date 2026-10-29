/**
 * Pure rate-limit arithmetic (R-AUTH-08, ADR-0009): token buckets for request rates and progressive backoff for
 * repeated failures. The store only loads and saves `BucketState`; every decision is made here.
 */

export interface BucketState {
  readonly tokens: number;
  readonly failures: number;
  readonly blockedUntil: Date | null;
  readonly updatedAt: Date;
}

export interface TokenBucket {
  readonly capacity: number;
  readonly refillPerSecond: number;
}

export interface Backoff {
  /** Consecutive failures that are allowed before the first block. */
  readonly freeFailures: number;
  readonly firstBlockMs: number;
  /** D-04: a victim can be locked out for at most this long at a time. */
  readonly maxBlockMs: number;
}

export interface TakeResult {
  readonly state: BucketState;
  /** 0 when the request may proceed; otherwise how long until the next token. */
  readonly retryAfterMs: number;
}

/** Keeps the counter far below the 32-bit column while staying above any meaningful threshold. */
const MAX_FAILURES = 1_000_000;

export function freshBucket(capacity: number, now: Date): BucketState {
  return { tokens: capacity, failures: 0, blockedUntil: null, updatedAt: now };
}

/** Refills the bucket for the elapsed time (a clock that went backwards adds nothing), then takes one token. */
export function takeToken(state: BucketState, bucket: TokenBucket, now: Date): TakeResult {
  const elapsedSeconds = Math.max(0, (now.getTime() - state.updatedAt.getTime()) / 1000);
  const available = Math.min(bucket.capacity, state.tokens + elapsedSeconds * bucket.refillPerSecond);
  if (available >= 1) return { state: { ...state, tokens: available - 1, updatedAt: now }, retryAfterMs: 0 };
  return {
    state: { ...state, tokens: available, updatedAt: now },
    retryAfterMs: Math.ceil(((1 - available) / bucket.refillPerSecond) * 1000),
  };
}

/** Milliseconds until the subject may try again; 0 when it is not blocked. */
export function blockedFor(state: BucketState, now: Date): number {
  return state.blockedUntil === null ? 0 : Math.max(0, state.blockedUntil.getTime() - now.getTime());
}

/** One more consecutive failure; beyond the free ones each failure blocks, twice as long as the last, up to a cap. */
export function afterFailure(state: BucketState, backoff: Backoff, now: Date): BucketState {
  const failures = Math.min(state.failures + 1, MAX_FAILURES);
  const excess = failures - backoff.freeFailures;
  if (excess <= 0) return { ...state, failures, updatedAt: now };
  const blockMs = Math.min(backoff.maxBlockMs, backoff.firstBlockMs * 2 ** (excess - 1));
  return { ...state, failures, blockedUntil: new Date(now.getTime() + blockMs), updatedAt: now };
}

export function afterSuccess(state: BucketState, now: Date): BucketState {
  return { ...state, failures: 0, blockedUntil: null, updatedAt: now };
}
