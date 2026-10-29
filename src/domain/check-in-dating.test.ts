import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkInDating } from './check-in-dating.ts';
import { addDays, fromDayNumber } from './dates.ts';

const TODAY = '2026-10-29';

describe('which check-ins count [R-CHK-04, Q-08]', () => {
  it('counts a check-in dated today', () => {
    expect(checkInDating(TODAY, TODAY)).toBe('counts');
  });

  it.each([1, 2, 7])('keeps a check-in dated %i day(s) back as history only', (daysBack) => {
    expect(checkInDating(addDays(TODAY, -daysBack), TODAY)).toBe('history');
  });

  it('refuses a check-in dated 8 days back', () => {
    expect(checkInDating(addDays(TODAY, -8), TODAY)).toBe('too_old');
  });

  it('refuses a check-in dated in the future', () => {
    expect(checkInDating(addDays(TODAY, 1), TODAY)).toBe('future');
  });

  it('depends only on the number of days between the two dates', () => {
    fc.assert(
      fc.property(fc.integer({ min: 19_000, max: 25_000 }), fc.integer({ min: -30, max: 30 }), (day, back) => {
        const today = fromDayNumber(day);
        const expected = back < 0 ? 'future' : back === 0 ? 'counts' : back <= 7 ? 'history' : 'too_old';

        expect(checkInDating(addDays(today, -back), today)).toBe(expected);
      }),
    );
  });
});
