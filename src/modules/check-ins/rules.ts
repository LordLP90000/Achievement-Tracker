import { checkInDating } from '../../domain/check-in-dating.ts';
import { daysBetween, type LocalDate } from '../../domain/dates.ts';
import type { AchievementStatus } from '../../domain/gamble.ts';
import type { QuestView } from '../goals/engine.ts';
import { decimalOf, OUT_OF_RANGE, violation, type RuleViolation } from '../quests/rules.ts';

/**
 * Whether a quest takes a check-in (R-CHK-01, R-CHK-04, R-CHK-05, Q-42, A-36): first its state as the goal engine
 * sees it today (409), then the request's own content (422). Messages are static and never echo a value.
 */

export interface CheckInInput {
  readonly localDate: LocalDate;
  /** Target quests only (contract `Decimal`). */
  readonly value: string | null;
  readonly note: string | null;
}

export type CheckInConflict = 'achievement_not_active' | 'quest_completed' | 'quest_needs_restart' | 'quest_locked';

export type CheckInRefusal = { readonly outcome: CheckInConflict } | RuleViolation;

const CONFLICTS = {
  completed: 'quest_completed',
  needs_restart: 'quest_needs_restart',
  locked: 'quest_locked',
} as const satisfies Record<string, CheckInConflict>;

/** The first reason the quest refuses the check-in, or null. */
export function checkInRefusal(
  input: CheckInInput,
  quest: QuestView,
  status: AchievementStatus,
  today: LocalDate,
): CheckInRefusal | null {
  if (status !== 'active') return { outcome: 'achievement_not_active' };
  const { state } = quest.evaluation;
  if (state !== 'available') return { outcome: CONFLICTS[state] };
  const isTarget = quest.record.target !== null;
  if (isTarget && input.value === null) return violation('/value', 'is required for a target quest');
  if (!isTarget && input.value !== null) return violation('/value', 'is only for target quests');
  if (input.value !== null && decimalOf(input.value) === null) return violation('/value', OUT_OF_RANGE);
  const dating = checkInDating(input.localDate, today);
  if (dating === 'future') return violation('/local_date', 'must not be in the future');
  if (dating === 'too_old') return violation('/local_date', 'must be at most 7 days back');
  const habit = quest.record.habit;
  // A-36: it would belong to no period and silently count for nothing; back-dated, it is kept as history.
  if (dating === 'counts' && habit !== null && daysBetween(today, habit.startDate) > 0) {
    return violation('/local_date', 'cannot count before the habit’s start date');
  }
  return null;
}
