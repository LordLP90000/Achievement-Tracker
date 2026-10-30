import { daysBetween, type LocalDate } from './dates.ts';
import { durationFactor, effectiveXp, type HabitPeriod, type HabitSpan, type QuestSize } from './duration.ts';
import { evaluateHabit, type CurrentPeriod } from './habit-reset.ts';
import type { WeekStart } from './periods.ts';
import {
  achievementProgress,
  habitProgress,
  oneTimeProgress,
  targetProgress,
  type WeightedProgress,
} from './progress.ts';
import { bestAfterRunEnds, habitStreak, type Streak } from './streak.ts';
import { habitStartOnUnlock, questState, type QuestState } from './transitions.ts';

/**
 * A quest at `today`, from its definition and the counting check-ins of the current attempt (R-QST-01…05, R-STR-01,
 * Q-35, Q-38): what every response shows and what the effects engine reconciles. Pure, so evaluating lazily on every
 * read and write agrees with the daily job (A-21).
 */

export interface CountingCheckIn {
  readonly localDate: LocalDate;
  /** Orders the check-ins of one day: the latest target value counts (R-QST-05). */
  readonly createdAtMs: number;
  /** Target quests: the value in thousandths (`decimal.ts`). */
  readonly value: number | null;
}

export interface HabitDefinition {
  readonly period: HabitPeriod;
  readonly timesPerPeriod: number;
  readonly periodCount: number;
  /** Start of the current run: creation or restart. */
  readonly startDate: LocalDate;
  /** The week start the run began with (Q-34). */
  readonly weekStart: WeekStart;
  /** A reset is stored: the quest waits for a restart (R-QST-04). */
  readonly needsRestart: boolean;
  /** The longest met-period count of the runs that ended (`habit_best_streak`). */
  readonly bestOfEndedRuns: number;
}

export type QuestDefinition =
  | { readonly type: 'one_time' }
  /** Start and target value in thousandths; they differ (R-QST-05). */
  | { readonly type: 'target'; readonly start: number; readonly target: number }
  | ({ readonly type: 'habit' } & HabitDefinition);

export interface QuestInput {
  readonly size: QuestSize;
  readonly definition: QuestDefinition;
  readonly checkIns: readonly CountingCheckIn[];
  /** The prerequisite exists and is not completed (R-QST-02). */
  readonly locked: boolean;
}

export interface QuestEvaluation {
  readonly xp: number;
  readonly durationFactor: number;
  readonly progress: number;
  readonly completed: boolean;
  readonly state: QuestState;
  /** Target quests: the latest counting value, else the start value (thousandths). */
  readonly currentValue: number | null;
  readonly streak: Streak | null;
  /** The open period of a running habit (Q-35). */
  readonly currentPeriod: CurrentPeriod | null;
  /** A closed period was missed: the run ended, and the service stores the reset with this best streak (R-QST-04). */
  readonly reset: { readonly bestOfEndedRuns: number } | null;
}

type Measure = Pick<QuestEvaluation, 'progress' | 'currentValue' | 'streak' | 'currentPeriod' | 'reset'> & {
  readonly needsRestart: boolean;
};

const PLAIN = { currentValue: null, streak: null, currentPeriod: null, reset: null, needsRestart: false } as const;

/** Later by date, then by creation; on equal instants the one given later counts. */
function isLatest(candidate: CountingCheckIn, latest: CountingCheckIn): boolean {
  const days = daysBetween(latest.localDate, candidate.localDate);
  return days > 0 || (days === 0 && candidate.createdAtMs >= latest.createdAtMs);
}

function latestValue(checkIns: readonly CountingCheckIn[]): number | null {
  let latest: CountingCheckIn | null = null;
  for (const checkIn of checkIns) {
    if (checkIn.value !== null && (latest === null || isLatest(checkIn, latest))) latest = checkIn;
  }
  return latest === null ? null : latest.value;
}

function measureHabit(
  definition: HabitDefinition,
  checkIns: readonly CountingCheckIn[],
  locked: boolean,
  today: LocalDate,
): Measure {
  const best = definition.bestOfEndedRuns;
  if (definition.needsRestart) {
    return { ...PLAIN, progress: 0, streak: { current: 0, best }, needsRestart: true };
  }
  // A locked habit never resets: its run starts on the unlock day once its start date has passed (Q-38).
  const startDate = locked ? habitStartOnUnlock(definition.startDate, today) : definition.startDate;
  const evaluation = evaluateHabit(
    {
      run: { period: definition.period, startDate, weekStart: definition.weekStart },
      timesPerPeriod: definition.timesPerPeriod,
      periodCount: definition.periodCount,
    },
    checkIns.map((checkIn) => checkIn.localDate),
    today,
  );
  const streak = habitStreak(evaluation, best);
  switch (evaluation.state) {
    case 'running':
      return {
        ...PLAIN,
        progress: habitProgress(evaluation.metPeriods, definition.periodCount),
        streak,
        currentPeriod: evaluation.currentPeriod,
      };
    case 'completed':
      return { ...PLAIN, progress: 1, streak };
    case 'reset':
      return {
        ...PLAIN,
        progress: 0,
        streak,
        reset: { bestOfEndedRuns: bestAfterRunEnds(best, evaluation) },
        needsRestart: true,
      };
  }
}

function measure(quest: QuestInput, today: LocalDate): Measure {
  const { definition } = quest;
  switch (definition.type) {
    case 'one_time':
      return { ...PLAIN, progress: oneTimeProgress(quest.checkIns.length) };
    case 'target': {
      const current = latestValue(quest.checkIns) ?? definition.start;
      return {
        ...PLAIN,
        progress: targetProgress(definition.start, definition.target, current),
        currentValue: current,
      };
    }
    case 'habit':
      return measureHabit(definition, quest.checkIns, quest.locked, today);
  }
}

export function evaluateQuest(quest: QuestInput, today: LocalDate): QuestEvaluation {
  const { definition } = quest;
  const span: HabitSpan | null =
    definition.type === 'habit' ? { period: definition.period, periodCount: definition.periodCount } : null;
  const measured = measure(quest, today);
  const completed = measured.progress === 1;
  return {
    xp: effectiveXp(quest.size, span),
    durationFactor: durationFactor(span),
    progress: measured.progress,
    completed,
    state: questState({ completed, needsRestart: measured.needsRestart, locked: quest.locked }),
    currentValue: measured.currentValue,
    streak: measured.streak,
    currentPeriod: measured.currentPeriod,
    reset: measured.reset,
  };
}

export interface AchievementSummary {
  readonly progress: number;
  /** Effective XP of the required quests (contract `xp_required_total`). */
  readonly xpRequiredTotal: number;
}

/** Progress and required XP of an achievement (R-ACH-03): XP-weighted over its required quests. */
export function summarizeAchievement(quests: readonly WeightedProgress[]): AchievementSummary {
  return {
    progress: achievementProgress(quests),
    xpRequiredTotal: quests.reduce((sum, quest) => sum + (quest.isRequired ? quest.xp : 0), 0),
  };
}
