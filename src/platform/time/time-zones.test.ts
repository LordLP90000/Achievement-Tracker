import { describe, expect, it } from 'vitest';
import { canonicalTimeZone, DEFAULT_TIME_ZONE, localDateOf } from './time-zones.ts';

describe('canonicalTimeZone (A-02)', () => {
  it('defaults to Europe/Zurich', () => {
    expect(DEFAULT_TIME_ZONE).toBe('Europe/Zurich');
  });

  it.each([
    ['Europe/Zurich', 'Europe/Zurich'],
    ['europe/zurich', 'Europe/Zurich'],
    ['America/New_York', 'America/New_York'],
    ['US/Eastern', 'America/New_York'],
    ['UTC', 'UTC'],
    ['Etc/UTC', 'UTC'],
    ['GMT', 'UTC'],
  ])('accepts %j and stores it as %j', (name, canonical) => {
    expect(canonicalTimeZone(name)).toBe(canonical);
  });

  it('accepts a renamed zone under its new name (devices report Europe/Kyiv, ICU may still call it Europe/Kiev)', () => {
    expect(canonicalTimeZone('Europe/Kyiv')).toMatch(/^Europe\/Ki(?:ev|yiv)$/);
  });

  it.each([
    'Mars/Olympus',
    '+01:00',
    '-0530',
    'Etc/GMT+5',
    'EST5EDT',
    'SystemV/AST4',
    '',
    ' Europe/Zurich',
    'Europe/Zurich ',
    '../../etc/passwd',
    `Europe/${'x'.repeat(58)}`,
  ])('refuses %j: not a region time zone of the IANA database', (name) => {
    expect(canonicalTimeZone(name)).toBeUndefined();
  });
});

describe('localDateOf: the calendar date of an instant in the user’s time zone [ADR-0011, R-STR-02, R-CHK-04]', () => {
  const dateIn = (instant: string, timeZone = 'Europe/Zurich') => localDateOf(new Date(instant), timeZone);

  it.each([
    ['2026-03-28T22:30:00Z', '23:30 CET', '2026-03-28'],
    ['2026-03-28T23:00:00Z', '00:00 CET', '2026-03-29'],
    ['2026-03-28T23:30:00Z', '00:30 CET', '2026-03-29'],
    ['2026-03-29T00:30:00Z', '01:30 CET', '2026-03-29'],
    ['2026-03-29T01:30:00Z', '03:30 CEST (02:30 does not exist)', '2026-03-29'],
    ['2026-03-29T21:59:59Z', '23:59:59 CEST', '2026-03-29'],
    ['2026-03-29T22:00:00Z', '00:00 CEST', '2026-03-30'],
  ])('Europe/Zurich, spring forward 2026-03-29: %s (%s) is %s', (instant, _local, date) => {
    expect(dateIn(instant)).toBe(date);
  });

  it.each([
    ['2026-10-24T21:59:59Z', '23:59:59 CEST', '2026-10-24'],
    ['2026-10-24T22:30:00Z', '00:30 CEST', '2026-10-25'],
    ['2026-10-25T00:30:00Z', '02:30 CEST, the first time', '2026-10-25'],
    ['2026-10-25T01:30:00Z', '02:30 CET, the second time', '2026-10-25'],
    ['2026-10-25T02:30:00Z', '03:30 CET', '2026-10-25'],
    ['2026-10-25T22:59:59Z', '23:59:59 CET', '2026-10-25'],
    ['2026-10-25T23:00:00Z', '00:00 CET', '2026-10-26'],
  ])('Europe/Zurich, fall back 2026-10-25: %s (%s) is %s', (instant, _local, date) => {
    expect(dateIn(instant)).toBe(date);
  });

  it('gives the same instant different dates in different zones (Pacific/Auckland as a second opinion)', () => {
    expect(dateIn('2026-10-29T11:30:00Z', 'UTC')).toBe('2026-10-29');
    expect(dateIn('2026-10-29T11:30:00Z', 'Pacific/Auckland')).toBe('2026-10-30');
    expect(dateIn('2026-10-29T11:30:00Z', 'America/Los_Angeles')).toBe('2026-10-29');
    // Auckland leaves daylight saving on 2026-04-05: 02:59 NZDT is followed by 02:00 NZST.
    expect(dateIn('2026-04-04T11:30:00Z', 'Pacific/Auckland')).toBe('2026-04-05');
    expect(dateIn('2026-04-05T11:59:59Z', 'Pacific/Auckland')).toBe('2026-04-05');
    expect(dateIn('2026-04-05T12:00:00Z', 'Pacific/Auckland')).toBe('2026-04-06');
  });

  it('pads years, months and days', () => {
    expect(dateIn('0999-01-02T12:00:00Z', 'UTC')).toBe('0999-01-02');
  });

  it('moves at most one day per hour, never backwards, through a whole year in Zurich', () => {
    const start = Date.parse('2026-01-01T00:00:00Z');
    let previous = localDateOf(new Date(start), 'Europe/Zurich');
    for (let hour = 1; hour <= 366 * 24; hour += 1) {
      const current = localDateOf(new Date(start + hour * 3_600_000), 'Europe/Zurich');
      if (current !== previous) {
        const nextDay = new Date(Date.parse(`${previous}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
        expect(current).toBe(nextDay);
      }
      previous = current;
    }
  });

  it('refuses an unknown time zone instead of guessing', () => {
    expect(() => localDateOf(new Date('2026-10-29T12:00:00Z'), 'Mars/Olympus')).toThrow(RangeError);
  });
});
