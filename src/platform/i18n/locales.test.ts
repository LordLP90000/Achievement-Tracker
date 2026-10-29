import { describe, expect, it } from 'vitest';
import { DEFAULT_LOCALE, isLocale, LOCALES } from './locales.ts';

describe('locales (A-02)', () => {
  it('offers exactly the locales of the contract and defaults to de-CH', () => {
    expect(LOCALES).toEqual(['de-CH', 'fr-CH', 'it-CH', 'en', 'de', 'fr', 'it']);
    expect(DEFAULT_LOCALE).toBe('de-CH');
  });

  it.each([
    ['fr-CH', true],
    ['en', true],
    ['en-US', false],
    ['de-ch', false],
    ['', false],
  ])('isLocale(%j) is %s', (value, expected) => {
    expect(isLocale(value)).toBe(expected);
  });
});
