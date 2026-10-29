import { BACKDATE_LIMIT_DAYS } from './constants.ts';
import { daysBetween, type LocalDate } from './dates.ts';

/**
 * Which check-ins count (R-CHK-04, Q-08): only those dated today in the account's time zone. Up to 7 days back they
 * are kept as history that never counts; older or future dates are refused.
 */
export type CheckInDating = 'counts' | 'history' | 'too_old' | 'future';

export function checkInDating(localDate: LocalDate, today: LocalDate): CheckInDating {
  const daysBack = daysBetween(localDate, today);
  if (daysBack < 0) return 'future';
  if (daysBack === 0) return 'counts';
  return daysBack <= BACKDATE_LIMIT_DAYS ? 'history' : 'too_old';
}
