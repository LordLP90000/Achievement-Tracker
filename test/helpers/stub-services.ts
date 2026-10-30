import type { AppServices } from '../../src/app.ts';
import type { RateLimiter } from '../../src/modules/rate-limit/limiter.ts';

/** A limiter that never refuses: for apps that test something else (rate limits have their own suite). */
export const ALLOW_ALL: RateLimiter = Object.freeze({
  take: () => Promise.resolve(0),
  blocked: () => Promise.resolve(0),
  record: () => Promise.resolve(),
});

const unavailable = (): Promise<never> =>
  Promise.reject(new Error('this test app has no database: use test/helpers/accounts-app.ts'));

/**
 * Services for apps built without a database: routes exist (spec coverage), nobody is authenticated, and any other
 * call fails loudly.
 */
export const UNAVAILABLE_SERVICES: AppServices = Object.freeze({
  accounts: { register: unavailable, verifyEmail: unavailable, resendVerification: unavailable },
  achievements: { list: unavailable, create: unavailable, get: unavailable },
  passwords: { change: unavailable, requestReset: unavailable, reset: unavailable },
  emailChanges: { request: unavailable, confirm: unavailable },
  profiles: { get: unavailable, update: unavailable },
  quests: { create: unavailable, list: unavailable, get: unavailable, update: unavailable, delete: unavailable },
  consents: { list: unavailable, grant: unavailable, withdraw: unavailable },
  rateLimiter: ALLOW_ALL,
  sessions: {
    login: unavailable,
    refresh: unavailable,
    authenticate: () => Promise.resolve(undefined),
    logout: unavailable,
    logoutAll: unavailable,
    listSessions: unavailable,
    revokeSession: unavailable,
    reauthenticate: unavailable,
  },
});
