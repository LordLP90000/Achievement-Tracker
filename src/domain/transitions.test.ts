import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  checkPrerequisite,
  habitStartOnUnlock,
  habitStructureEditable,
  questState,
  statusChange,
  targetValuesEditable,
} from './transitions.ts';

describe('achievement status requested by the client [R-ACH-06, R-ACH-07, Q-17]', () => {
  it.each([
    ['active', 'paused', 'pause'],
    ['paused', 'active', 'resume'],
    ['active', 'active', 'unchanged'],
    ['paused', 'paused', 'unchanged'],
    ['completed', 'active', 'completed-read-only'],
    ['completed', 'paused', 'completed-read-only'],
  ] as const)('%s → %s: %s', (current, requested, change) => {
    expect(statusChange(current, requested)).toBe(change);
  });
});

describe('quest states [R-QST-02, R-QST-04]', () => {
  it.each([
    [{ completed: true, needsRestart: false, locked: false }, 'completed'],
    [{ completed: true, needsRestart: true, locked: true }, 'completed'],
    [{ completed: false, needsRestart: true, locked: true }, 'needs_restart'],
    [{ completed: false, needsRestart: false, locked: true }, 'locked'],
    [{ completed: false, needsRestart: false, locked: false }, 'available'],
  ] as const)('%o is %s', (quest, state) => {
    expect(questState(quest)).toBe(state);
  });
});

describe('prerequisites: same achievement, no cycles, chains of at most 20 links [R-QST-02, A-16]', () => {
  /** `chain(n)` = q0 ← q1 ← … ← qn: q1 requires q0 and so on. */
  const chain = (links: number) =>
    new Map<string, string | null>(
      Array.from({ length: links + 1 }, (_, i) => [`q${String(i)}`, i === 0 ? null : `q${String(i - 1)}`]),
    );

  it('accepts a quest of the same achievement', () => {
    expect(checkPrerequisite('new', 'q2', chain(2))).toBeNull();
    expect(checkPrerequisite('q2', 'q0', chain(2))).toBeNull();
  });

  it('refuses a quest that is not in the achievement — unknown or another achievement’s, which look the same', () => {
    expect(checkPrerequisite('new', 'elsewhere', chain(2))).toBe('unknown');
  });

  it('refuses the quest itself and any cycle', () => {
    expect(checkPrerequisite('q1', 'q1', chain(2))).toBe('cycle');
    expect(checkPrerequisite('q0', 'q2', chain(2))).toBe('cycle');
    expect(checkPrerequisite('q1', 'q2', chain(3))).toBe('cycle');
  });

  it('allows a chain of 20 links and refuses the 21st, counted on both sides of the changed quest', () => {
    expect(checkPrerequisite('new', 'q19', chain(19))).toBeNull();
    expect(checkPrerequisite('new', 'q20', chain(20))).toBe('too_deep');
    const twoChains = new Map([...chain(10)]);
    for (let i = 0; i <= 10; i += 1) twoChains.set(`r${String(i)}`, i === 0 ? null : `r${String(i - 1)}`);

    expect(checkPrerequisite('r0', 'q9', twoChains)).toBeNull();
    expect(checkPrerequisite('r0', 'q10', twoChains)).toBe('too_deep');
  });

  it('measures the deepest of several dependents', () => {
    const tree = new Map<string, string | null>([
      ['root', null],
      ['a', 'root'],
      ['b', 'a'],
      ['c', 'root'],
      ['top', null],
    ]);
    /** Below `b`: x0 requires b, x1 requires x0, … — `links` more links under root. */
    const deeper = (links: number) => {
      const map = new Map(tree);
      for (let i = 0; i < links; i += 1) map.set(`x${String(i)}`, i === 0 ? 'b' : `x${String(i - 1)}`);
      return map;
    };

    expect(checkPrerequisite('root', 'top', tree)).toBeNull();
    expect(checkPrerequisite('root', 'top', deeper(17))).toBeNull();
    expect(checkPrerequisite('root', 'top', deeper(18))).toBe('too_deep');
  });

  it('never accepts a link that closes a cycle, in any acyclic achievement', () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 30 }), fc.nat(), fc.nat(), (size, a, b) => {
        // A random forest: each quest points to an earlier one or to none.
        const forest = new Map<string, string | null>();
        for (let i = 0; i < size; i += 1) {
          forest.set(`q${String(i)}`, i > 0 && (a + i) % 3 > 0 ? `q${String((a * 31 + b) % i)}` : null);
        }
        const from = `q${String(a % size)}`;
        const to = `q${String(b % size)}`;
        let reachesFrom = false;
        for (let current: string | null = to; current !== null; current = forest.get(current) ?? null) {
          if (current === from) reachesFrom = true;
        }

        expect(checkPrerequisite(from, to, forest) === 'cycle').toBe(reachesFrom);
      }),
    );
  });

  it('stops at corrupt stored links that already form a cycle instead of looping', () => {
    const corrupt = new Map<string, string | null>([
      ['a', 'b'],
      ['b', 'a'],
      ['new', null],
    ]);

    expect(checkPrerequisite('new', 'a', corrupt)).toBe('cycle');
  });
});

describe('habit settings that are fixed while a run is open or completed [Q-37, Q-38]', () => {
  const habit = { needsRestart: false, locked: false, startDate: '2026-10-29' };

  it('fixes period, N, K, start date and prerequisite once the run has begun', () => {
    expect(habitStructureEditable(habit, '2026-10-29')).toBe(false);
    expect(habitStructureEditable(habit, '2026-11-15')).toBe(false);
  });

  it('allows them before the run’s start date, at a restart, and while the habit is locked (its run has not begun)', () => {
    expect(habitStructureEditable({ ...habit, startDate: '2026-10-30' }, '2026-10-29')).toBe(true);
    expect(habitStructureEditable({ ...habit, needsRestart: true }, '2026-11-15')).toBe(true);
    expect(habitStructureEditable({ ...habit, locked: true }, '2026-11-15')).toBe(true);
  });

  it('starts a locked habit’s run on the day it unlocks if its start date has passed by then (Q-38)', () => {
    expect(habitStartOnUnlock('2026-10-20', '2026-10-29')).toBe('2026-10-29');
    expect(habitStartOnUnlock('2026-11-02', '2026-10-29')).toBe('2026-11-02');
    expect(habitStartOnUnlock('2026-10-29', '2026-10-29')).toBe('2026-10-29');
  });
});

describe('target values of a completed quest are fixed [A-37]', () => {
  it('allows them while the quest is incomplete and fixes them once it is complete', () => {
    expect(targetValuesEditable({ completed: false })).toBe(true);
    expect(targetValuesEditable({ completed: true })).toBe(false);
  });
});
