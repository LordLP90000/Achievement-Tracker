import { describe, expect, it } from 'vitest';
import { systemClock } from './clock.ts';

describe('systemClock', () => {
  it('returns the current instant', () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    const after = Date.now();

    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });

  it('returns a new Date on every call, so a caller cannot change what others see', () => {
    const first = systemClock.now();
    first.setUTCFullYear(2000);

    expect(systemClock.now().getUTCFullYear()).toBeGreaterThan(2000);
  });

  it('cannot be replaced at runtime', () => {
    expect(Object.isFrozen(systemClock)).toBe(true);
  });
});
