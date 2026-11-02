import { describe, expect, it } from 'vitest';
import {
  afterFailure,
  afterSuccess,
  blockedFor,
  freshBucket,
  slidingWindowWait,
  takeToken,
  type BucketState,
} from './policy.ts';

const T0 = new Date('2026-10-29T12:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const bucket = { capacity: 3, refillPerSecond: 0.5 };
const backoff = { freeFailures: 2, firstBlockMs: 60_000, maxBlockMs: 15 * 60_000 };

describe('token bucket', () => {
  it('starts full', () => {
    expect(freshBucket(3, T0)).toEqual({ tokens: 3, failures: 0, blockedUntil: null, updatedAt: T0 });
  });

  it('takes one token per request until the bucket is empty, then names the wait for the next token', () => {
    let state: BucketState = freshBucket(3, T0);
    const waits = [];
    for (let request = 0; request < 4; request += 1) {
      const result = takeToken(state, bucket, T0);
      state = result.state;
      waits.push(result.retryAfterMs);
    }

    expect(waits).toEqual([0, 0, 0, 2000]);
    expect(state.tokens).toBe(0);
  });

  it('refills with the elapsed time, never beyond its capacity', () => {
    const empty: BucketState = { ...freshBucket(3, T0), tokens: 0 };

    expect(takeToken(empty, bucket, at(1999)).retryAfterMs).toBe(1);
    expect(takeToken(empty, bucket, at(2000))).toEqual({
      state: { ...empty, tokens: 0, updatedAt: at(2000) },
      retryAfterMs: 0,
    });
    expect(takeToken(empty, bucket, at(3_600_000)).state.tokens).toBe(2);
  });

  it('does not take a token from a refused request', () => {
    const almost: BucketState = { ...freshBucket(3, T0), tokens: 0.5 };

    const result = takeToken(almost, bucket, T0);

    expect(result).toEqual({ state: { ...almost, tokens: 0.5, updatedAt: T0 }, retryAfterMs: 1000 });
  });

  it('treats a clock that went backwards as no time elapsed', () => {
    const empty: BucketState = { ...freshBucket(3, at(5000)), tokens: 0 };

    expect(takeToken(empty, bucket, T0).state.tokens).toBe(0);
  });
});

describe('progressive backoff after failures [D-04]', () => {
  const failTimes = (count: number) => {
    let state = freshBucket(0, T0);
    for (let failure = 0; failure < count; failure += 1) state = afterFailure(state, backoff, T0);
    return state;
  };

  it('lets the first failures pass without a block', () => {
    expect(failTimes(2)).toMatchObject({ failures: 2, blockedUntil: null });
    expect(blockedFor(failTimes(2), T0)).toBe(0);
  });

  it('blocks from the next failure on, doubling each time up to the cap', () => {
    const blocks = [3, 4, 5, 6, 7, 8, 40].map((count) => blockedFor(failTimes(count), T0));

    expect(blocks).toEqual([60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000]);
  });

  it('counts the block down and lifts it when it is over', () => {
    const blocked = failTimes(3);

    expect(blockedFor(blocked, at(59_999))).toBe(1);
    expect(blockedFor(blocked, at(60_000))).toBe(0);
  });

  it('forgets every failure after a success', () => {
    expect(afterSuccess(failTimes(5), at(1))).toEqual({
      tokens: 0,
      failures: 0,
      blockedUntil: null,
      updatedAt: at(1),
    });
  });

  it('caps the failure counter so it cannot overflow its integer column', () => {
    const many: BucketState = { ...freshBucket(0, T0), failures: 1_000_000 };

    expect(afterFailure(many, backoff, T0).failures).toBe(1_000_000);
  });
});

describe('sliding window: at most n events in any span [R-PRIV-05, D-09]', () => {
  const HOUR = 3_600_000;
  const twicePerDay = { limit: 2, windowMs: 24 * HOUR };

  it('lets events through until the window holds the limit', () => {
    expect(slidingWindowWait(twicePerDay, [], T0)).toBe(0);
    expect(slidingWindowWait(twicePerDay, [at(-HOUR)], T0)).toBe(0);
  });

  it('then waits until the earliest event that must go leaves the window, not until a calendar day ends', () => {
    expect(slidingWindowWait(twicePerDay, [at(-2 * HOUR), at(-HOUR)], T0)).toBe(22 * HOUR);
    expect(slidingWindowWait(twicePerDay, [at(-HOUR), at(-2 * HOUR)], T0)).toBe(22 * HOUR);
    expect(slidingWindowWait(twicePerDay, [at(-3 * HOUR), at(-2 * HOUR), at(-HOUR)], T0)).toBe(22 * HOUR);
  });

  it('forgets an event exactly one window old, and counts one stamped after now (a clock ahead) as recent', () => {
    expect(slidingWindowWait(twicePerDay, [at(-24 * HOUR), at(-HOUR)], T0)).toBe(0);
    expect(slidingWindowWait(twicePerDay, [at(-24 * HOUR + 1), at(-HOUR)], T0)).toBe(1);
    expect(slidingWindowWait(twicePerDay, [at(-HOUR), at(HOUR)], T0)).toBe(23 * HOUR);
  });
});
