import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { addDays } from './dates.ts';
import {
  evaluateQuest,
  summarizeAchievement,
  type CountingCheckIn,
  type HabitDefinition,
  type QuestDefinition,
  type QuestInput,
} from './quest-evaluation.ts';

const TODAY = '2026-10-29'; // a Thursday

const checkIn = (localDate: string, value: number | null = null, createdAtMs = 0): CountingCheckIn => ({
  localDate,
  createdAtMs,
  value,
});
const quest = (definition: QuestDefinition, checkIns: CountingCheckIn[] = [], overrides: Partial<QuestInput> = {}) =>
  ({ size: 'M', definition, checkIns, locked: false, ...overrides }) satisfies QuestInput;
const habit = (overrides: Partial<HabitDefinition> = {}): QuestDefinition => ({
  type: 'habit',
  period: 'week',
  timesPerPeriod: 3,
  periodCount: 4,
  startDate: '2026-10-26',
  weekStart: 'monday',
  needsRestart: false,
  bestOfEndedRuns: 0,
  ...overrides,
});
/** Losing weight from 80 kg to 70 kg, in thousandths. */
const target: QuestDefinition = { type: 'target', start: 80_000, target: 70_000 };

describe('quest evaluation [R-QST-01…05, R-STR-01, Q-35, Q-38]', () => {
  describe('one-time quests', () => {
    it('are open without a counting check-in and worth their size in XP', () => {
      expect(evaluateQuest(quest({ type: 'one_time' }), TODAY)).toEqual({
        xp: 25,
        durationFactor: 1,
        progress: 0,
        completed: false,
        state: 'available',
        currentValue: null,
        streak: null,
        currentPeriod: null,
        reset: null,
      });
    });

    it('complete with their first counting check-in', () => {
      const evaluation = evaluateQuest(quest({ type: 'one_time' }, [checkIn(TODAY)]), TODAY);

      expect(evaluation).toMatchObject({ progress: 1, completed: true, state: 'completed' });
    });

    it.each([
      ['S', 10],
      ['M', 25],
      ['L', 50],
    ] as const)('are worth %s = %i XP', (size, xp) => {
      expect(evaluateQuest(quest({ type: 'one_time' }, [], { size }), TODAY).xp).toBe(xp);
    });

    it('are locked while their prerequisite is open, unless already complete', () => {
      expect(evaluateQuest(quest({ type: 'one_time' }, [], { locked: true }), TODAY).state).toBe('locked');
      expect(evaluateQuest(quest({ type: 'one_time' }, [checkIn(TODAY)], { locked: true }), TODAY).state).toBe(
        'completed',
      );
    });
  });

  describe('target quests', () => {
    it('start at the start value', () => {
      expect(evaluateQuest(quest(target), TODAY)).toMatchObject({
        currentValue: 80_000,
        progress: 0,
        completed: false,
        streak: null,
        currentPeriod: null,
      });
    });

    it('measure the latest counting value by date, then by creation, whatever the order given', () => {
      const evaluation = evaluateQuest(
        quest(target, [
          checkIn('2026-10-28', 75_000, 5),
          checkIn('2026-10-27', 76_000, 9),
          checkIn('2026-10-26', 71_000, 1),
        ]),
        TODAY,
      );

      expect(evaluation).toMatchObject({ currentValue: 75_000, progress: 0.5 });
    });

    it('take the later of two values of one day, and the later given on equal instants', () => {
      expect(
        evaluateQuest(quest(target, [checkIn(TODAY, 72_000, 2), checkIn(TODAY, 74_000, 1)]), TODAY).currentValue,
      ).toBe(72_000);
      expect(
        evaluateQuest(quest(target, [checkIn(TODAY, 72_000, 1), checkIn(TODAY, 74_000, 1)]), TODAY).currentValue,
      ).toBe(74_000);
    });

    it('complete when the target is reached or passed, and open again when the value moves back', () => {
      expect(evaluateQuest(quest(target, [checkIn(TODAY, 69_500)]), TODAY)).toMatchObject({
        progress: 1,
        completed: true,
        state: 'completed',
      });
      expect(
        evaluateQuest(quest(target, [checkIn('2026-10-28', 69_500), checkIn(TODAY, 71_000)]), TODAY),
      ).toMatchObject({ progress: 0.9, completed: false, state: 'available' });
    });

    it('also work upwards', () => {
      const increasing: QuestDefinition = { type: 'target', start: 0, target: 42_000 };

      expect(evaluateQuest(quest(increasing, [checkIn(TODAY, 21_000)]), TODAY).progress).toBe(0.5);
    });

    it('ignore a check-in without a value (target check-ins always carry one, R-CHK-05)', () => {
      expect(evaluateQuest(quest(target, [checkIn('2026-10-28', 75_000), checkIn(TODAY)]), TODAY).currentValue).toBe(
        75_000,
      );
      expect(evaluateQuest(quest(target, [checkIn(TODAY)]), TODAY).currentValue).toBe(80_000);
    });
  });

  describe('habit quests', () => {
    it('show the open period with its counting check-ins, and progress by met periods', () => {
      const evaluation = evaluateQuest(quest(habit(), [checkIn('2026-10-26'), checkIn('2026-10-27')]), TODAY);

      expect(evaluation).toEqual({
        xp: 25,
        durationFactor: 1,
        progress: 0,
        completed: false,
        state: 'available',
        currentValue: null,
        streak: { current: 0, best: 0 },
        currentPeriod: { start: '2026-10-26', end: '2026-11-01', checkIns: 2, required: 3 },
        reset: null,
      });
    });

    it('count the open period once it is met', () => {
      const dates = ['2026-10-26', '2026-10-27', TODAY].map((date) => checkIn(date));

      expect(evaluateQuest(quest(habit(), dates), TODAY)).toMatchObject({
        progress: 0.25,
        streak: { current: 1, best: 1 },
        currentPeriod: { checkIns: 3, required: 3 },
      });
    });

    it('reset when a closed period was missed: no progress, a restart needed and the run’s streak kept as best', () => {
      const firstWeek = ['2026-10-12', '2026-10-13', '2026-10-14'].map((date) => checkIn(date));

      const evaluation = evaluateQuest(quest(habit({ startDate: '2026-10-12', bestOfEndedRuns: 0 }), firstWeek), TODAY);

      expect(evaluation).toMatchObject({
        progress: 0,
        completed: false,
        state: 'needs_restart',
        streak: { current: 0, best: 1 },
        currentPeriod: null,
        reset: { bestOfEndedRuns: 1 },
      });
    });

    it('keep a better streak of an earlier run as the best after a reset', () => {
      const evaluation = evaluateQuest(quest(habit({ startDate: '2026-10-12', bestOfEndedRuns: 5 })), TODAY);

      expect(evaluation).toMatchObject({ streak: { current: 0, best: 5 }, reset: { bestOfEndedRuns: 5 } });
    });

    it('complete with the K-th met period', () => {
      const dates = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-19', '2026-10-20', '2026-10-21'];

      const evaluation = evaluateQuest(
        quest(
          habit({ startDate: '2026-10-12', periodCount: 2 }),
          dates.map((date) => checkIn(date)),
        ),
        TODAY,
      );

      expect(evaluation).toMatchObject({
        progress: 1,
        completed: true,
        state: 'completed',
        streak: { current: 2, best: 2 },
        currentPeriod: null,
        reset: null,
      });
    });

    it('wait for a restart once reset: no open period, no progress, the best streak of the ended runs', () => {
      const evaluation = evaluateQuest(
        quest(habit({ startDate: '2026-10-12', needsRestart: true, bestOfEndedRuns: 3 }), [checkIn(TODAY)]),
        TODAY,
      );

      expect(evaluation).toMatchObject({
        progress: 0,
        completed: false,
        state: 'needs_restart',
        streak: { current: 0, best: 3 },
        currentPeriod: null,
        reset: null,
      });
    });

    it('never reset while locked: the run starts on the unlock day when the start date has passed (Q-38)', () => {
      const evaluation = evaluateQuest(quest(habit({ startDate: '2026-10-12' }), [], { locked: true }), TODAY);

      expect(evaluation).toMatchObject({
        state: 'locked',
        progress: 0,
        reset: null,
        currentPeriod: { start: TODAY, end: '2026-11-08', checkIns: 0, required: 3 },
      });
    });

    it('keep a future start date while locked', () => {
      const evaluation = evaluateQuest(quest(habit({ startDate: '2026-11-02' }), [], { locked: true }), TODAY);

      expect(evaluation.currentPeriod).toEqual({ start: '2026-11-02', end: '2026-11-08', checkIns: 0, required: 3 });
    });

    it('count daily periods, the open one being today', () => {
      const daily = habit({ period: 'day', timesPerPeriod: 1, periodCount: 3, startDate: '2026-10-27' });

      const evaluation = evaluateQuest(quest(daily, [checkIn('2026-10-27'), checkIn('2026-10-28')]), TODAY);

      expect(evaluation).toMatchObject({
        progress: 2 / 3,
        streak: { current: 2, best: 2 },
        currentPeriod: { start: TODAY, end: TODAY, checkIns: 0, required: 1 },
      });
    });

    it.each([
      ['week', 4, 'M', 1, 25],
      ['week', 8, 'M', 1.5, 38],
      ['week', 16, 'S', 2, 20],
      ['day', 113, 'L', 3, 150],
    ] as const)(
      'weigh a %s habit over %i periods of size %s by ×%d: %i XP',
      (period, periodCount, size, factor, xp) => {
        const evaluation = evaluateQuest(quest(habit({ period, periodCount }), [], { size }), TODAY);

        expect(evaluation).toMatchObject({ durationFactor: factor, xp });
      },
    );
  });

  describe('every quest', () => {
    const dates = fc.integer({ min: -40, max: 0 }).map((offset) => addDays(TODAY, offset));
    const checkIns = fc.array(
      fc.record({
        localDate: dates,
        createdAtMs: fc.nat(1000),
        value: fc.integer({ min: 60_000, max: 90_000 }),
      }),
      { maxLength: 30 },
    );
    const definitions = fc.oneof(
      fc.constant<QuestDefinition>({ type: 'one_time' }),
      fc
        .tuple(fc.integer({ min: 60_000, max: 90_000 }), fc.integer({ min: 60_000, max: 90_000 }))
        .filter(([start, end]) => start !== end)
        .map(([start, end]): QuestDefinition => ({ type: 'target', start, target: end })),
      fc
        .record({
          period: fc.constantFrom('day' as const, 'week' as const),
          timesPerPeriod: fc.integer({ min: 1, max: 3 }),
          periodCount: fc.integer({ min: 1, max: 6 }),
          startDate: fc.integer({ min: -40, max: 5 }).map((offset) => addDays(TODAY, offset)),
          weekStart: fc.constantFrom('monday' as const, 'sunday' as const, 'saturday' as const),
          needsRestart: fc.boolean(),
          bestOfEndedRuns: fc.nat(10),
        })
        .map((definition): QuestDefinition => ({ type: 'habit', ...definition })),
    );
    const quests = fc.record({
      size: fc.constantFrom('S' as const, 'M' as const, 'L' as const),
      definition: definitions,
      checkIns,
      locked: fc.boolean(),
    });

    it('agree on completion: progress 1, the completed state and no open period go together', () => {
      fc.assert(
        fc.property(quests, (input) => {
          const evaluation = evaluateQuest(input, TODAY);
          expect(evaluation.progress).toBeGreaterThanOrEqual(0);
          expect(evaluation.progress).toBeLessThanOrEqual(1);
          expect(evaluation.completed).toBe(evaluation.progress === 1);
          expect(evaluation.state === 'completed').toBe(evaluation.completed);
          if (evaluation.completed) expect(evaluation.currentPeriod).toBeNull();
        }),
      );
    });

    it('reset only unlocked, running habits, and only into needs_restart', () => {
      fc.assert(
        fc.property(quests, (input) => {
          const evaluation = evaluateQuest(input, TODAY);
          const resettable = input.definition.type === 'habit' && !input.definition.needsRestart && !input.locked;
          if (evaluation.reset !== null) {
            expect(resettable).toBe(true);
            expect(evaluation.state).toBe('needs_restart');
            expect(evaluation.currentPeriod).toBeNull();
          }
          expect(evaluation.streak === null).toBe(input.definition.type !== 'habit');
        }),
      );
    });
  });
});

describe('achievement summary [R-ACH-03]', () => {
  it('weighs the progress of the required quests by their XP and sums the XP they require', () => {
    expect(
      summarizeAchievement([
        { isRequired: true, xp: 25, progress: 1 },
        { isRequired: true, xp: 50, progress: 0.5 },
        { isRequired: false, xp: 10, progress: 0 },
      ]),
    ).toEqual({ progress: 50 / 75, xpRequiredTotal: 75 });
  });

  it('has no progress and requires no XP without required quests', () => {
    expect(summarizeAchievement([])).toEqual({ progress: 0, xpRequiredTotal: 0 });
    expect(summarizeAchievement([{ isRequired: false, xp: 50, progress: 1 }])).toEqual({
      progress: 0,
      xpRequiredTotal: 0,
    });
  });
});
