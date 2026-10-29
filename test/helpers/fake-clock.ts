import type { Clock } from '../../src/platform/time/clock.ts';

export interface Duration {
  readonly milliseconds?: number;
  readonly seconds?: number;
  readonly minutes?: number;
  readonly hours?: number;
  readonly days?: number;
}

const MS_PER_UNIT: Readonly<Record<keyof Duration, number>> = {
  milliseconds: 1,
  seconds: 1000,
  minutes: 60_000,
  hours: 3_600_000,
  days: 86_400_000,
};

/** ISO 8601 date-time with `Z` or an explicit offset (`2026-03-29T00:30:00+01:00`), never machine-local time. */
const EXPLICIT_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function parseInstant(instant: string): number {
  const epochMs = EXPLICIT_INSTANT.test(instant) ? Date.parse(instant) : Number.NaN;
  if (Number.isNaN(epochMs)) {
    throw new Error(`FakeClock needs an ISO instant with Z or an explicit offset, got ${JSON.stringify(instant)}`);
  }
  return epochMs;
}

/** A clock that only moves when a test moves it (test strategy §8: explicit instants with zone). */
export class FakeClock implements Clock {
  #epochMs: number;

  constructor(instant: string) {
    this.#epochMs = parseInstant(instant);
  }

  now(): Date {
    return new Date(this.#epochMs);
  }

  set(instant: string): void {
    this.#epochMs = parseInstant(instant);
  }

  /** Adds an absolute duration: a "day" is 24 hours even across a DST change (use `set` for wall-clock times). */
  advance(duration: Duration): void {
    let total = 0;
    for (const [unit, amount] of Object.entries(duration) as [keyof Duration, number][]) {
      if (!Number.isFinite(amount) || amount < 0) {
        throw new Error(`FakeClock can only advance by finite, non-negative amounts, got ${unit}: ${String(amount)}`);
      }
      total += amount * MS_PER_UNIT[unit];
    }
    this.#epochMs += total;
  }
}
