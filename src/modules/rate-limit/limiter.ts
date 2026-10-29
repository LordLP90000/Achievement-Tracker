import { inTransaction, type Database } from '../../platform/db/database.ts';
import type { Clock } from '../../platform/time/clock.ts';
import { bucketKey, dailyKey } from './keys.ts';
import {
  afterFailure,
  afterSuccess,
  blockedFor,
  freshBucket,
  takeToken,
  type Backoff,
  type TokenBucket,
} from './policy.ts';
import { lockBuckets, saveBucket } from './repository.ts';

/**
 * Shared rate limits (R-AUTH-08, ADR-0009): every API instance reads and writes the same PostgreSQL buckets.
 * Proposed values (A-31) — tune with the M6 load test.
 */

export interface TokenLimit {
  readonly scope: string;
  readonly bucket: TokenBucket;
}

export interface BackoffLimit {
  readonly scope: string;
  readonly backoff: Backoff;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;

export const LIMITS = {
  /** Every public auth endpoint, per client IPv4 address or IPv6 /64: 20 per minute. */
  ipAuth: { scope: 'ip-auth', bucket: { capacity: 20, refillPerSecond: 20 / MINUTE } },
  /** Requests that may email an address, per submitted address (registered or not): 3 per hour (A-25, D-05). */
  emailMail: { scope: 'email-mail', bucket: { capacity: 3, refillPerSecond: 3 / HOUR } },
  /** Email-change requests, per user: 3 per hour (D-05). */
  userMail: { scope: 'user-mail', bucket: { capacity: 3, refillPerSecond: 3 / HOUR } },
  /** Every authenticated request, per user: 120 per minute. */
  user: { scope: 'user', bucket: { capacity: 120, refillPerSecond: 120 / MINUTE } },
} as const satisfies Record<string, TokenLimit>;

const PASSWORD_BACKOFF: Backoff = { freeFailures: 5, firstBlockMs: 60_000, maxBlockMs: 15 * 60_000 };

export const BACKOFFS = {
  /** Wrong passwords at login, per submitted address (registered or not): 5 free, then 1 min doubling to 15 min. */
  emailLogin: { scope: 'email-login', backoff: PASSWORD_BACKOFF },
  /** Wrong current passwords at re-authentication and password change, per user. */
  userPassword: { scope: 'user-password', backoff: PASSWORD_BACKOFF },
} as const satisfies Record<string, BackoffLimit>;

export interface RateLimiter {
  /** Takes a token from the subject's bucket; whole seconds to wait (0 = go ahead, nothing taken otherwise). */
  take(limit: TokenLimit, subject: string): Promise<number>;
  /** Whole seconds the subject is still blocked after repeated failures (0 = may try). */
  blocked(limit: BackoffLimit, subject: string): Promise<number>;
  /** Failures add up to a block; a success clears them. */
  record(limit: BackoffLimit, subject: string, succeeded: boolean): Promise<void>;
}

export interface RateLimiterDependencies {
  readonly db: Database;
  readonly clock: Clock;
  readonly rateLimitKey: Uint8Array;
}

const toSeconds = (ms: number) => Math.ceil(ms / 1000);

export function createRateLimiter(deps: RateLimiterDependencies): RateLimiter {
  const keyOf = (scope: string, subject: string, now: Date) =>
    bucketKey(dailyKey(deps.rateLimitKey, now), scope, subject);

  return {
    async take(limit, subject) {
      const now = deps.clock.now();
      const bucket = { key: keyOf(limit.scope, subject, now), initial: freshBucket(limit.bucket.capacity, now) };
      return inTransaction(deps.db, async (tx) => {
        let waitMs = 0;
        for (const { state } of await lockBuckets(tx, [bucket])) {
          const result = takeToken(state, limit.bucket, now);
          waitMs = result.retryAfterMs;
          await saveBucket(tx, bucket.key, result.state);
        }
        return toSeconds(waitMs);
      });
    },

    async blocked(limit, subject) {
      const now = deps.clock.now();
      const bucket = { key: keyOf(limit.scope, subject, now), initial: freshBucket(0, now) };
      return inTransaction(deps.db, async (tx) => {
        const locked = await lockBuckets(tx, [bucket]);
        return toSeconds(Math.max(0, ...locked.map(({ state }) => blockedFor(state, now))));
      });
    },

    async record(limit, subject, succeeded) {
      const now = deps.clock.now();
      const bucket = { key: keyOf(limit.scope, subject, now), initial: freshBucket(0, now) };
      await inTransaction(deps.db, async (tx) => {
        for (const { state } of await lockBuckets(tx, [bucket])) {
          await saveBucket(
            tx,
            bucket.key,
            succeeded ? afterSuccess(state, now) : afterFailure(state, limit.backoff, now),
          );
        }
      });
    },
  };
}
