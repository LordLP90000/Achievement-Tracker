import { describe, expect, it } from 'vitest';
import { hasRecentReauth, REAUTH_WINDOW_MS, type Principal } from './guard.ts';

describe('hasRecentReauth [R-AUTH-06]', () => {
  const lastReauthAt = new Date('2026-10-29T12:00:00Z');
  const principal: Principal = {
    userId: '6f1c2a4e-8d3b-4c5a-9e7f-1a2b3c4d5e6f',
    sessionId: '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    lastReauthAt,
  };
  const after = (offsetMs: number) => hasRecentReauth(principal, new Date(lastReauthAt.getTime() + offsetMs));

  it('is 10 minutes', () => {
    expect(REAUTH_WINDOW_MS).toBe(10 * 60 * 1000);
  });

  it.each([0, 1, REAUTH_WINDOW_MS - 1])(
    'allows a sensitive operation %i ms after the password was entered',
    (offset) => {
      expect(after(offset)).toBe(true);
    },
  );

  it.each([REAUTH_WINDOW_MS, REAUTH_WINDOW_MS + 1, 24 * 3600 * 1000])('refuses it %i ms after', (offset) => {
    expect(after(offset)).toBe(false);
  });
});
