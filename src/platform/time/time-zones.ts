/** IANA time zones (A-02): every habit period, streak and "today" is computed in the user's zone. */

export const DEFAULT_TIME_ZONE = 'Europe/Zurich';

const NAME = /^[a-z][\w+/-]{0,63}$/i;
// Region zones of the IANA database known to this runtime's ICU, plus UTC (which the list omits).
const SUPPORTED = new Set([...Intl.supportedValuesOf('timeZone'), 'UTC']);

/**
 * The canonical name of an IANA time zone (`europe/zurich` → `Europe/Zurich`, `US/Eastern` → `America/New_York`,
 * `Etc/UTC` → `UTC`), or `undefined` for anything else: offsets, POSIX-style and legacy non-region names.
 */
export function canonicalTimeZone(name: string): string | undefined {
  if (!NAME.test(name)) return undefined;
  let canonical: string;
  try {
    canonical = new Intl.DateTimeFormat('en', { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
  return SUPPORTED.has(canonical) ? canonical : undefined;
}

/** One formatter per zone: building them is costly, and the zones in use are few (stored canonical names). */
const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * The calendar date `YYYY-MM-DD` of `instant` in `timeZone` (ADR-0011): "today" for check-ins and habit periods.
 * Daylight saving time only changes which instants fall on a date. An unknown zone throws a `RangeError`.
 */
export function localDateOf(instant: Date, timeZone: string): string {
  let formatter = formatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(timeZone, formatter);
  }
  const parts = formatter.formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((candidate) => candidate.type === type)?.value ?? '';
  return `${part('year').padStart(4, '0')}-${part('month')}-${part('day')}`;
}
