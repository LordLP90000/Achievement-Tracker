import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  assertGambleTransition,
  placeGamble,
  revertWin,
  settleAsLost,
  settleOnUnlock,
  targetDatePassed,
  type PlacementInputs,
} from './gamble.ts';
import { levelForXp, xpAboveLevel } from './xp.ts';

const DAY_MS = 86_400_000;
const allowed: PlacementInputs = {
  achievementStatus: 'active',
  targetDate: '2026-11-15',
  today: '2026-10-29',
  userHasPendingGamble: false,
  lostThisAttempt: false,
  totalXp: 450,
};

describe('placing a gamble [R-GMB-01, Q-31, A-27, T-17]', () => {
  it('stakes the XP above the threshold of the current level, computed here and never taken from the client', () => {
    expect(placeGamble(allowed)).toEqual({ outcome: 'placed', stake: 150 });
  });

  it.each([
    ['a paused achievement', { achievementStatus: 'paused' }, 'achievement-not-active'],
    ['a completed achievement', { achievementStatus: 'completed' }, 'achievement-not-active'],
    ['no target date', { targetDate: null }, 'gamble-target-date-required'],
    ['a target date of today', { targetDate: '2026-10-29' }, 'gamble-target-date-required'],
    ['a past target date', { targetDate: '2026-10-28' }, 'gamble-target-date-required'],
    ['a pending gamble on any achievement of the user (Q-31)', { userHasPendingGamble: true }, 'gamble-pending'],
    ['a gamble lost in this attempt (A-27)', { lostThisAttempt: true }, 'gamble-lost-this-attempt'],
    ['nothing above the level threshold', { totalXp: 300 }, 'nothing-to-stake'],
    ['no XP at all', { totalXp: 0 }, 'nothing-to-stake'],
  ] as const)('refuses %s', (_case, change, reason) => {
    expect(placeGamble({ ...allowed, ...change })).toEqual({ outcome: 'refused', reason });
  });

  it('checks in the contract’s order: not active, then the target date, then a pending gamble, a loss, the stake', () => {
    const everythingWrong: PlacementInputs = {
      achievementStatus: 'paused',
      targetDate: null,
      today: '2026-10-29',
      userHasPendingGamble: true,
      lostThisAttempt: true,
      totalXp: 0,
    };

    expect(placeGamble(everythingWrong)).toMatchObject({ reason: 'achievement-not-active' });
    expect(placeGamble({ ...everythingWrong, achievementStatus: 'active' })).toMatchObject({
      reason: 'gamble-target-date-required',
    });
    expect(placeGamble({ ...everythingWrong, achievementStatus: 'active', targetDate: '2026-11-01' })).toMatchObject({
      reason: 'gamble-pending',
    });
    expect(
      placeGamble({
        ...everythingWrong,
        achievementStatus: 'active',
        targetDate: '2026-11-01',
        userHasPendingGamble: false,
      }),
    ).toMatchObject({ reason: 'gamble-lost-this-attempt' });
  });
});

describe('settling a gamble [R-GMB-02, R-GMB-03, Q-31, A-20, A-34]', () => {
  const unlock = { requiredXp: 500, achievementAgeMs: 30 * DAY_MS, totalXp: 450 };

  it('wins double or nothing when the achievement unlocks on or before the target date', () => {
    expect(settleOnUnlock({ stake: 150, targetDate: '2026-11-15' }, { ...unlock, date: '2026-11-15' })).toEqual({
      outcome: 'won',
      xpDelta: 150,
    });
    expect(settleOnUnlock({ stake: 150, targetDate: '2026-11-15' }, { ...unlock, date: '2026-11-01' })).toEqual({
      outcome: 'won',
      xpDelta: 150,
    });
  });

  it('pays at most the achievement’s required XP (Q-31)', () => {
    expect(
      settleOnUnlock({ stake: 150, targetDate: '2026-11-15' }, { ...unlock, requiredXp: 60, date: '2026-11-01' }),
    ).toEqual({ outcome: 'won', xpDelta: 60 });
  });

  it('pays nothing for an achievement unlocked less than 7 × 24 hours after its creation, but still counts as won (A-34)', () => {
    const young = { ...unlock, date: '2026-11-01' };

    expect(
      settleOnUnlock({ stake: 150, targetDate: '2026-11-15' }, { ...young, achievementAgeMs: 7 * DAY_MS - 1 }),
    ).toEqual({
      outcome: 'won',
      xpDelta: 0,
    });
    expect(
      settleOnUnlock({ stake: 150, targetDate: '2026-11-15' }, { ...young, achievementAgeMs: 7 * DAY_MS }),
    ).toEqual({
      outcome: 'won',
      xpDelta: 150,
    });
  });

  it('loses when the achievement unlocks after the target date, as the daily job would have settled it', () => {
    expect(settleOnUnlock({ stake: 150, targetDate: '2026-11-15' }, { ...unlock, date: '2026-11-16' })).toEqual({
      outcome: 'lost',
      xpDelta: -150,
      lossReason: 'target_date_passed',
    });
  });

  it.each(['target_date_passed', 'habit_reset', 'paused', 'deleted'] as const)(
    'loses the stake on %s, but never more than the XP above the current level’s threshold (Q-31)',
    (reason) => {
      expect(settleAsLost(150, 450, reason)).toEqual({ outcome: 'lost', xpDelta: -150, lossReason: reason });
      expect(settleAsLost(150, 340, reason)).toEqual({ outcome: 'lost', xpDelta: -40, lossReason: reason });
      expect(settleAsLost(150, 300, reason)).toEqual({ outcome: 'lost', xpDelta: 0, lossReason: reason });
      expect(settleAsLost(150, 300, reason).xpDelta).toBe(0);
    },
  );

  it('never lowers the level or the total below 0 [R-XP-03, R-XP-04]', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), fc.nat(1_000_000_000), (stake, totalXp) => {
        const loss = settleAsLost(stake, totalXp, 'habit_reset');

        expect(levelForXp(totalXp + loss.xpDelta)).toBe(levelForXp(totalXp));
        expect(-loss.xpDelta).toBeLessThanOrEqual(Math.min(stake, xpAboveLevel(totalXp)));
      }),
    );
  });

  it('settles a missed target date only once the date has fully passed in the account’s time zone (A-20)', () => {
    expect(targetDatePassed('2026-11-15', '2026-11-15')).toBe(false);
    expect(targetDatePassed('2026-11-15', '2026-11-16')).toBe(true);
    expect(targetDatePassed('2026-11-15', '2026-11-01')).toBe(false);
  });

  it('takes back exactly what a win paid when its unlock is undone [R-ACH-05]', () => {
    expect(revertWin(150)).toEqual({ outcome: 'reverted', xpDelta: -150 });
    expect(revertWin(0)).toEqual({ outcome: 'reverted', xpDelta: 0 });
    expect(revertWin(0).xpDelta).toBe(0);
  });
});

describe('gamble states: settled exactly once [R-GMB-04, T-17]', () => {
  it.each([
    ['pending', 'won'],
    ['pending', 'lost'],
    ['won', 'pending'],
  ] as const)('allows %s → %s', (from, to) => {
    expect(() => {
      assertGambleTransition(from, to);
    }).not.toThrow();
  });

  it.each([
    ['pending', 'pending'],
    ['won', 'won'],
    ['won', 'lost'],
    ['lost', 'pending'],
    ['lost', 'won'],
    ['lost', 'lost'],
  ] as const)('refuses %s → %s: a loss is final and nothing settles twice', (from, to) => {
    expect(() => {
      assertGambleTransition(from, to);
    }).toThrow(`a gamble cannot go from ${from} to ${to}`);
  });
});
