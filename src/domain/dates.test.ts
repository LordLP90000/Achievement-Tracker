import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addDays, daysBetween, fromDayNumber, isoWeekday, toDayNumber } from './dates.ts';

const MS_PER_DAY = 86_400_000;
/** The runtime's proleptic Gregorian calendar as an oracle. */
const oracleDay = (date: string) => Date.parse(`${date}T00:00:00Z`) / MS_PER_DAY;
const FIRST_DAY = toDayNumber('0000-01-01');
const LAST_DAY = toDayNumber('9999-12-31');
const anyDayNumber = fc.integer({ min: FIRST_DAY, max: LAST_DAY });

describe('calendar dates, never instants (ADR-0011)', () => {
  it.each([
    ['1970-01-01', 0],
    ['1970-01-02', 1],
    ['1969-12-31', -1],
    ['2000-02-29', 11_016],
    ['2000-03-01', 11_017],
    ['2026-10-29', 20_755],
    ['0000-01-01', -719_528],
    ['9999-12-31', 2_932_896],
  ])('%s is day %i of the Unix epoch', (date, day) => {
    expect(toDayNumber(date)).toBe(day);
    expect(fromDayNumber(day)).toBe(date);
  });

  it.each(['2024-02-29', '2000-02-29', '1600-02-29', '2026-01-31', '2026-04-30', '2026-12-31'])(
    'accepts %s',
    (date) => {
      expect(fromDayNumber(toDayNumber(date))).toBe(date);
    },
  );

  it.each([
    '2026-02-29',
    '2100-02-29',
    '1900-02-29',
    '2026-04-31',
    '2026-13-01',
    '2026-00-10',
    '2026-04-00',
    '2026-1-01',
    '26-01-01',
    '2026-01-01T00:00',
    ' 2026-01-01',
    '',
  ])('refuses %j', (date) => {
    expect(() => toDayNumber(date)).toThrow(RangeError);
    expect(() => toDayNumber(date)).toThrow('no such date: a date is YYYY-MM-DD');
  });

  it.each([0.5, Number.NaN, FIRST_DAY - 1, LAST_DAY + 1])('refuses day number %d', (day) => {
    expect(() => fromDayNumber(day)).toThrow(RangeError);
    expect(() => fromDayNumber(day)).toThrow('a day number names a date from 0000-01-01 to 9999-12-31');
  });

  it('agrees with the runtime calendar on every day of a whole 400-year cycle, after which the calendar repeats', () => {
    const mismatches: string[] = [];
    const first = oracleDay('1600-03-01');
    for (let day = first; day <= first + 146_097; day += 1) {
      const expected = new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
      if (fromDayNumber(day) !== expected || toDayNumber(expected) !== day) mismatches.push(expected);
    }

    expect(mismatches).toEqual([]);
  });

  it('adds days and counts the days between two dates across month, year and leap-day boundaries', () => {
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
    expect(addDays('2026-10-29', 0)).toBe('2026-10-29');
    expect(daysBetween('2026-10-29', '2026-11-05')).toBe(7);
    expect(daysBetween('2026-11-05', '2026-10-29')).toBe(-7);
    expect(daysBetween('2024-02-28', '2024-03-01')).toBe(2);
  });

  it.each([
    ['1970-01-01', 4],
    ['2026-10-26', 1],
    ['2026-10-29', 4],
    ['2026-10-31', 6],
    ['2026-11-01', 7],
    ['2000-01-01', 6],
  ])('%s is ISO weekday %i (1 = Monday … 7 = Sunday)', (date, weekday) => {
    expect(isoWeekday(date)).toBe(weekday);
  });

  describe('properties', () => {
    it('day numbers and dates convert both ways', () => {
      fc.assert(
        fc.property(anyDayNumber, (day) => {
          expect(toDayNumber(fromDayNumber(day))).toBe(day);
        }),
      );
    });

    it('agree with the runtime calendar', () => {
      fc.assert(
        fc.property(anyDayNumber, (day) => {
          expect(oracleDay(fromDayNumber(day))).toBe(day);
        }),
      );
    });

    it('adding n days moves the date n days, and the weekday along', () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 2_000_000 }), fc.integer({ min: -100_000, max: 100_000 }), (day, n) => {
          const date = fromDayNumber(day);
          const later = addDays(date, n);
          expect(daysBetween(date, later)).toBe(n);
          expect(isoWeekday(later)).toBe(((((isoWeekday(date) - 1 + n) % 7) + 7) % 7) + 1);
        }),
      );
    });
  });
});
