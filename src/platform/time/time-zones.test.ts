import { describe, expect, it } from 'vitest';
import { canonicalTimeZone, DEFAULT_TIME_ZONE } from './time-zones.ts';

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
