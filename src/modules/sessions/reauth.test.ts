import { describe, expect, it } from 'vitest';
import { ProblemError } from '../../platform/http/validation.ts';
import { REAUTH_WINDOW_MS, requireRecentReauth, type Principal } from './guard.ts';

describe('requireRecentReauth [R-AUTH-06]', () => {
  const lastReauthAt = new Date('2026-10-29T12:00:00Z');
  const principal: Principal = {
    userId: '6f1c2a4e-8d3b-4c5a-9e7f-1a2b3c4d5e6f',
    sessionId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    lastReauthAt,
  };
  /** The error thrown `offsetMs` after the password was entered, if any. */
  const failureAfter = (offsetMs: number): unknown => {
    try {
      requireRecentReauth(principal, new Date(lastReauthAt.getTime() + offsetMs));
      return undefined;
    } catch (error) {
      return error;
    }
  };

  it('is 10 minutes', () => {
    expect(REAUTH_WINDOW_MS).toBe(10 * 60 * 1000);
  });

  it.each([0, 1, REAUTH_WINDOW_MS - 1])(
    'allows a sensitive operation %i ms after the password was entered',
    (offset) => {
      expect(failureAfter(offset)).toBeUndefined();
    },
  );

  it.each([REAUTH_WINDOW_MS, REAUTH_WINDOW_MS + 1, 24 * 3600 * 1000])(
    'answers 403 reauthentication-required %i ms after',
    (offset) => {
      const failure = failureAfter(offset);

      expect(failure).toBeInstanceOf(ProblemError);
      expect((failure as ProblemError).problem).toMatchObject({ status: 403, slug: 'reauthentication-required' });
    },
  );
});
