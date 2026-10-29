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
