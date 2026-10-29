/**
 * Decimal values of target quests and check-ins (A-05, data-model §1): at most 3 fractional digits and |value| ≤ 10^9,
 * held exactly as integer thousandths and written canonically ("80.5"), so float rounding never reaches progress
 * or ciphertexts.
 */
export const MAX_DECIMAL_VALUE = 1_000_000_000;

const SCALE = 1000;
const MAX_THOUSANDTHS = MAX_DECIMAL_VALUE * SCALE;
const DECIMAL = /^(-?)(\d{1,10})(?:\.(\d{1,3}))?$/;
const INVALID = 'a decimal has at most 3 fractional digits and |value| ≤ 10^9';

/** Thousandths of a decimal string; `-0` reads as 0. */
export function parseDecimal(text: string): number {
  const match = DECIMAL.exec(text);
  if (match === null) throw new RangeError(INVALID);
  const [, sign, whole, fraction = ''] = match;
  const magnitude = Number(whole) * SCALE + Number(fraction.padEnd(3, '0'));
  if (magnitude > MAX_THOUSANDTHS) throw new RangeError(INVALID);
  return sign === '-' && magnitude > 0 ? -magnitude : magnitude;
}

/** The canonical string of a value in thousandths: no trailing zeros, no `-0`. */
export function formatDecimal(thousandths: number): string {
  if (!Number.isSafeInteger(thousandths) || Math.abs(thousandths) > MAX_THOUSANDTHS) throw new RangeError(INVALID);
  const magnitude = Math.abs(thousandths);
  const fraction = String(magnitude % SCALE)
    .padStart(3, '0')
    .replace(/0+$/, '');
  const sign = thousandths < 0 ? '-' : '';
  return `${sign}${String(Math.floor(magnitude / SCALE))}${fraction === '' ? '' : `.${fraction}`}`;
}
