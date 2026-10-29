/**
 * Calendar dates `YYYY-MM-DD` (ADR-0011). Habit periods, streaks and the back-dating rule work on these, never on
 * instants, so daylight saving time cannot shift them. A day number counts days from 1970-01-01 in the proleptic
 * Gregorian calendar (H. Hinnant's `days_from_civil` and `civil_from_days`), for the years 0000–9999.
 */
export type LocalDate = string;

const LOCAL_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** Days in 400 Gregorian years: the calendar repeats after one such era. */
const DAYS_PER_ERA = 146_097;
/** 0000-03-01 is day −719 468: eras start in March, so the leap day is the last day of a year. */
const DAYS_FROM_ERA_START_TO_EPOCH = 719_468;
const MONTHS_OF_30_DAYS = [4, 6, 9, 11];
const NO_SUCH_DATE = 'no such date: a date is YYYY-MM-DD';

const floorDiv = (dividend: number, divisor: number) => Math.floor(dividend / divisor);
const pad = (value: number, width: number) => String(value).padStart(width, '0');

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return isLeapYear(year) ? 29 : 28;
  return MONTHS_OF_30_DAYS.includes(month) ? 30 : 31;
}

export function toDayNumber(date: LocalDate): number {
  const match = LOCAL_DATE.exec(date);
  if (match === null) throw new RangeError(NO_SUCH_DATE);
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(year, month))) throw new RangeError(NO_SUCH_DATE);
  const marchYear = month <= 2 ? year - 1 : year;
  const era = floorDiv(marchYear, 400);
  const yearOfEra = marchYear - era * 400;
  const dayOfYear = floorDiv(153 * (month > 2 ? month - 3 : month + 9) + 2, 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + floorDiv(yearOfEra, 4) - floorDiv(yearOfEra, 100) + dayOfYear;
  return era * DAYS_PER_ERA + dayOfEra - DAYS_FROM_ERA_START_TO_EPOCH;
}

const FIRST_DAY = toDayNumber('0000-01-01');
const LAST_DAY = toDayNumber('9999-12-31');

export function fromDayNumber(dayNumber: number): LocalDate {
  if (!Number.isInteger(dayNumber) || dayNumber < FIRST_DAY || dayNumber > LAST_DAY) {
    throw new RangeError('a day number names a date from 0000-01-01 to 9999-12-31');
  }
  const fromEraStart = dayNumber + DAYS_FROM_ERA_START_TO_EPOCH;
  const era = floorDiv(fromEraStart, DAYS_PER_ERA);
  const dayOfEra = fromEraStart - era * DAYS_PER_ERA;
  const yearOfEra = floorDiv(
    dayOfEra - floorDiv(dayOfEra, 1460) + floorDiv(dayOfEra, 36_524) - floorDiv(dayOfEra, 146_096),
    365,
  );
  const dayOfYear = dayOfEra - (365 * yearOfEra + floorDiv(yearOfEra, 4) - floorDiv(yearOfEra, 100));
  const monthFromMarch = floorDiv(5 * dayOfYear + 2, 153);
  const day = dayOfYear - floorDiv(153 * monthFromMarch + 2, 5) + 1;
  const month = monthFromMarch < 10 ? monthFromMarch + 3 : monthFromMarch - 9;
  const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);
  return `${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`;
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return fromDayNumber(toDayNumber(date) + days);
}

/** Days from `from` to `to`: negative when `to` comes first. */
export function daysBetween(from: LocalDate, to: LocalDate): number {
  return toDayNumber(to) - toDayNumber(from);
}

/** 1 = Monday … 7 = Sunday; 1970-01-01 was a Thursday. */
export function isoWeekday(date: LocalDate): number {
  return ((((toDayNumber(date) + 3) % 7) + 7) % 7) + 1;
}
