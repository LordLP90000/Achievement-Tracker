import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { formatDecimal, MAX_DECIMAL_VALUE, parseDecimal } from './decimal.ts';

describe('decimal values of target quests and check-ins [A-05, data-model §1]', () => {
  it.each([
    ['0', 0],
    ['-0', 0],
    ['-0.000', 0],
    ['80.5', 80_500],
    ['80.50', 80_500],
    ['-12.345', -12_345],
    ['007', 7_000],
    ['1000000000', 1_000_000_000_000],
    ['-1000000000', -1_000_000_000_000],
    ['0.001', 1],
  ])('reads %j as %i thousandths', (text, thousandths) => {
    expect(parseDecimal(text)).toBe(thousandths);
  });

  it.each([
    [0, '0'],
    [80_500, '80.5'],
    [-12_345, '-12.345'],
    [7_000, '7'],
    [1, '0.001'],
    [-10, '-0.01'],
    [1_000_000_000_000, '1000000000'],
  ])('writes %i thousandths canonically as %j', (thousandths, text) => {
    expect(formatDecimal(thousandths)).toBe(text);
  });

  it('writes −0 as 0', () => {
    expect(formatDecimal(-0)).toBe('0');
    expect(formatDecimal(parseDecimal('-0.000'))).toBe('0');
  });

  it.each(['', '1.', '.5', '1.2345', '1e3', '+1', ' 1', '1,5', '--1', '12345678901', '1000000000.001', 'NaN'])(
    'refuses %j',
    (text) => {
      expect(() => parseDecimal(text)).toThrow(RangeError);
      expect(() => parseDecimal(text)).toThrow('a decimal has at most 3 fractional digits and |value| ≤ 10^9');
    },
  );

  it.each([0.5, Number.NaN, MAX_DECIMAL_VALUE * 1000 + 1])('refuses %d thousandths', (thousandths) => {
    expect(() => formatDecimal(thousandths)).toThrow(RangeError);
    expect(() => formatDecimal(thousandths)).toThrow('a decimal has at most 3 fractional digits and |value| ≤ 10^9');
  });

  it('caps values at 10^9 either way (A-05)', () => {
    expect(MAX_DECIMAL_VALUE).toBe(1_000_000_000);
  });

  it('reads back exactly what it writes', () => {
    fc.assert(
      fc.property(fc.integer({ min: -MAX_DECIMAL_VALUE * 1000, max: MAX_DECIMAL_VALUE * 1000 }), (thousandths) => {
        expect(parseDecimal(formatDecimal(thousandths))).toBe(thousandths + 0);
      }),
    );
  });
});
