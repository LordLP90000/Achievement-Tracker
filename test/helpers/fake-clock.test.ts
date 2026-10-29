import { describe, expect, it } from 'vitest';
import { FakeClock } from './fake-clock.ts';

describe('FakeClock (test harness, architecture §4.6)', () => {
  it('starts at an instant given with an explicit offset', () => {
    const clock = new FakeClock('2026-03-29T00:30:00+01:00');

    expect(clock.now().toISOString()).toBe('2026-03-28T23:30:00.000Z');
  });

  it.each(['2026-03-29T00:30:00', '2026-03-29', 'not an instant', '2026-13-01T00:00:00Z', ''])(
    'refuses %j: without an explicit offset the meaning would depend on the machine time zone',
    (instant) => {
      expect(() => new FakeClock(instant)).toThrow(/FakeClock/);
    },
  );

  it('stands still until a test moves it', async () => {
    const clock = new FakeClock('2026-10-29T12:00:00Z');
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(clock.now().toISOString()).toBe('2026-10-29T12:00:00.000Z');
  });

  it('jumps to a new instant with set', () => {
    const clock = new FakeClock('2026-10-29T12:00:00Z');
    clock.set('2026-10-25T02:30:00+02:00');

    expect(clock.now().toISOString()).toBe('2026-10-25T00:30:00.000Z');
    expect(() => {
      clock.set('2026-10-25T02:30:00');
    }).toThrow(/FakeClock/);
  });

  it('advances by absolute durations, so a day across a DST change is still 24 hours', () => {
    const clock = new FakeClock('2026-03-28T12:00:00+01:00');
    clock.advance({ days: 1 });
    expect(clock.now().toISOString()).toBe('2026-03-29T11:00:00.000Z');

    clock.advance({ hours: 1, minutes: 30, seconds: 15, milliseconds: 5 });
    expect(clock.now().toISOString()).toBe('2026-03-29T12:30:15.005Z');
  });

  it.each([{ minutes: -1 }, { hours: Number.NaN }, { days: Number.POSITIVE_INFINITY }])(
    'refuses to advance by %j',
    (duration) => {
      const clock = new FakeClock('2026-10-29T12:00:00Z');

      expect(() => {
        clock.advance(duration);
      }).toThrow(/FakeClock/);
      expect(clock.now().toISOString()).toBe('2026-10-29T12:00:00.000Z');
    },
  );

  it('hands out copies, so a caller cannot move the clock', () => {
    const clock = new FakeClock('2026-10-29T12:00:00Z');
    clock.now().setUTCFullYear(2000);

    expect(clock.now().toISOString()).toBe('2026-10-29T12:00:00.000Z');
  });
});
