import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, fromDayNumber, isoWeekday } from './dates.ts';
import { periodIndexOf, periodKeyFor, periodOfRun, weekStartOf, type HabitRun, type WeekStart } from './periods.ts';

const weekly = (startDate: string, weekStart: WeekStart = 'monday'): HabitRun => ({
  period: 'week',
  startDate,
  weekStart,
});
const daily = (startDate: string): HabitRun => ({ period: 'day', startDate, weekStart: 'monday' });
const WEEK_STARTS: readonly WeekStart[] = ['monday', 'sunday', 'saturday'];
const ISO_DAY: Record<WeekStart, number> = { monday: 1, sunday: 7, saturday: 6 };

describe('calendar weeks by the user’s week start [R-QST-09, Q-18]', () => {
  it.each([
    ['monday', '2026-10-26'],
    ['sunday', '2026-10-25'],
    ['saturday', '2026-10-24'],
  ] as const)('with %s weeks, Thursday 2026-10-29 belongs to the week of %s', (weekStart, first) => {
    expect(weekStartOf('2026-10-29', weekStart)).toBe(first);
    expect(weekStartOf(first, weekStart)).toBe(first);
    expect(periodKeyFor('2026-10-29', 'week', weekStart)).toBe(first);
  });

  it('keys a daily period by its own date', () => {
    expect(periodKeyFor('2026-10-29', 'day', 'sunday')).toBe('2026-10-29');
  });

  it('crosses the year end: 2026 has an ISO week 53 for Monday weeks', () => {
    expect(weekStartOf('2027-01-01', 'monday')).toBe('2026-12-28');
    expect(weekStartOf('2027-01-03', 'monday')).toBe('2026-12-28');
    expect(weekStartOf('2027-01-04', 'monday')).toBe('2027-01-04');
    expect(weekStartOf('2027-01-01', 'saturday')).toBe('2026-12-26');
    expect(weekStartOf('2027-01-01', 'sunday')).toBe('2026-12-27');
  });
});

describe('periods of a habit run [R-QST-04, R-QST-09, Q-33, Q-34]', () => {
  it('runs a daily habit one day at a time from its start date', () => {
    const run = daily('2026-10-29');

    expect(periodOfRun(run, 0)).toEqual({ start: '2026-10-29', end: '2026-10-29' });
    expect(periodOfRun(run, 3)).toEqual({ start: '2026-11-01', end: '2026-11-01' });
    expect(periodIndexOf(run, '2026-11-01')).toBe(3);
  });

  it.each([
    ['Monday 2026-10-26', '2026-10-26', 'monday', '2026-11-01', 7],
    ['Tuesday 2026-10-27', '2026-10-27', 'monday', '2026-11-08', 13],
    ['Sunday 2026-11-01', '2026-11-01', 'monday', '2026-11-08', 8],
    ['Thursday 2026-10-29', '2026-10-29', 'sunday', '2026-11-07', 10],
    ['Saturday 2026-10-31', '2026-10-31', 'saturday', '2026-11-06', 7],
  ] as const)(
    'a weekly habit started on %s with %s weeks: the first period runs to the end of the first full week (Q-33)',
    (_label, startDate, weekStart, firstEnd, days) => {
      const run = weekly(startDate, weekStart);
      const first = periodOfRun(run, 0);

      expect(first).toEqual({ start: startDate, end: firstEnd });
      expect(daysBetween(first.start, first.end) + 1).toBe(days);
      expect(periodOfRun(run, 1)).toEqual({ start: addDays(firstEnd, 1), end: addDays(firstEnd, 7) });
    },
  );

  it('finds the period of a date, and none before the run starts', () => {
    const run = weekly('2026-10-27');

    expect(periodIndexOf(run, '2026-10-26')).toBe(-1);
    expect(periodIndexOf(run, '2026-10-27')).toBe(0);
    expect(periodIndexOf(run, '2026-11-08')).toBe(0);
    expect(periodIndexOf(run, '2026-11-09')).toBe(1);
    expect(periodIndexOf(run, '2026-11-15')).toBe(1);
    expect(periodIndexOf(run, '2026-11-16')).toBe(2);
    expect(periodIndexOf(daily('2026-10-29'), '2026-10-28')).toBe(-1);
  });

  it('keeps the week start the run began with, whatever the account says later (Q-34)', () => {
    const run = weekly('2026-10-26', 'monday');

    expect(periodOfRun(run, 1)).toEqual({ start: '2026-11-02', end: '2026-11-08' });
    expect(periodOfRun({ ...run, weekStart: 'sunday' }, 1)).toEqual({ start: '2026-11-08', end: '2026-11-14' });
  });

  it.each([-1, 0.5, Number.NaN])('refuses period index %d', (index) => {
    expect(() => periodOfRun(weekly('2026-10-26'), index)).toThrow(RangeError);
    expect(() => periodOfRun(weekly('2026-10-26'), index)).toThrow('a period index is a whole number from 0');
  });

  describe('properties', () => {
    const runs = fc.record({
      period: fc.constantFrom<HabitRun['period']>('day', 'week'),
      startDate: fc.integer({ min: 19_000, max: 25_000 }).map(fromDayNumber),
      weekStart: fc.constantFrom(...WEEK_STARTS),
    });

    it('periods follow each other without gaps or overlaps, all but the first a full day or calendar week', () => {
      fc.assert(
        fc.property(runs, fc.integer({ min: 0, max: 600 }), (run, index) => {
          const period = periodOfRun(run, index);
          const next = periodOfRun(run, index + 1);
          const length = daysBetween(period.start, period.end) + 1;

          expect(next.start).toBe(addDays(period.end, 1));
          if (index === 0) {
            expect(period.start).toBe(run.startDate);
            expect(length).toBeGreaterThanOrEqual(run.period === 'day' ? 1 : 7);
            expect(length).toBeLessThanOrEqual(run.period === 'day' ? 1 : 13);
          } else {
            expect(length).toBe(run.period === 'day' ? 1 : 7);
            if (run.period === 'week') expect(isoWeekday(period.start)).toBe(ISO_DAY[run.weekStart]);
          }
        }),
      );
    });

    it('every day of a period maps back to that period', () => {
      fc.assert(
        fc.property(runs, fc.integer({ min: 0, max: 600 }), fc.integer({ min: 0, max: 12 }), (run, index, offset) => {
          const period = periodOfRun(run, index);
          const day = addDays(period.start, Math.min(offset, daysBetween(period.start, period.end)));

          expect(periodIndexOf(run, day)).toBe(index);
        }),
      );
    });
  });
});
