import type { AppServices } from '../../src/app.ts';

const unavailable = (): Promise<never> =>
  Promise.reject(new Error('this test app has no database: use test/helpers/accounts-app.ts'));

/**
 * Services for apps built without a database: routes exist (spec coverage), nobody is authenticated, and any other
 * call fails loudly.
 */
export const UNAVAILABLE_SERVICES: AppServices = Object.freeze({
  accounts: { register: unavailable, verifyEmail: unavailable, resendVerification: unavailable },
  passwords: { change: unavailable, requestReset: unavailable, reset: unavailable },
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
