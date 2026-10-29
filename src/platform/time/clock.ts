/** Source of the current instant, injected everywhere so tests control time (architecture §4.6). */
export interface Clock {
  /** A new `Date` on every call: callers may not share or mutate the clock's state. */
  now(): Date;
}

export const systemClock: Clock = Object.freeze({ now: () => new Date() });
