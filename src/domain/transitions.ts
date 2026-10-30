import { MAX_PREREQUISITE_DEPTH } from './constants.ts';
import { daysBetween, fromDayNumber, toDayNumber, type LocalDate } from './dates.ts';
import type { AchievementStatus } from './gamble.ts';

/**
 * State machines of achievements and quests and the rules that keep them non-gameable: client status changes
 * (R-ACH-07), quest states and prerequisites (R-QST-02, A-16), and the habit settings that are fixed while a run is
 * open or completed (Q-37, Q-38, A-37).
 */

export type RequestedStatus = 'active' | 'paused';
export type StatusChange = 'unchanged' | 'pause' | 'resume' | 'completed-read-only';

/** Clients may pause and resume; `completed` is set by the system only and is read-only (R-ACH-07, Q-17). */
export function statusChange(current: AchievementStatus, requested: RequestedStatus): StatusChange {
  if (current === 'completed') return 'completed-read-only';
  if (current === requested) return 'unchanged';
  return requested === 'paused' ? 'pause' : 'resume';
}

export type QuestState = 'locked' | 'available' | 'needs_restart' | 'completed';

export interface QuestStateFacts {
  readonly completed: boolean;
  readonly needsRestart: boolean;
  /** The prerequisite exists and is not completed (R-QST-02). */
  readonly locked: boolean;
}

export function questState(quest: QuestStateFacts): QuestState {
  if (quest.completed) return 'completed';
  if (quest.needsRestart) return 'needs_restart';
  return quest.locked ? 'locked' : 'available';
}

export type PrerequisiteRefusal = 'unknown' | 'cycle' | 'too_deep';

/**
 * May `questId` require `prerequisiteId`? `prerequisites` maps every quest of the achievement to its prerequisite
 * before the change. The prerequisite must belong to the achievement (an unknown ID and another achievement's look
 * the same), and with the new link no walk up the prerequisites may meet a quest twice (a cycle — corrupt stored
 * links are refused the same way) or take more than 20 links (A-16).
 */
export function checkPrerequisite(
  questId: string,
  prerequisiteId: string,
  prerequisites: ReadonlyMap<string, string | null>,
): PrerequisiteRefusal | null {
  if (!prerequisites.has(prerequisiteId)) return 'unknown';
  const links = new Map(prerequisites).set(questId, prerequisiteId);
  let deepest = 0;
  for (const start of links.keys()) {
    const seen = new Set<string>();
    let depth = -1;
    for (let current: string | null = start; current !== null; current = links.get(current) ?? null) {
      if (seen.has(current)) return 'cycle';
      seen.add(current);
      depth += 1;
    }
    deepest = Math.max(deepest, depth);
  }
  return deepest > MAX_PREREQUISITE_DEPTH ? 'too_deep' : null;
}

export interface HabitEditFacts {
  readonly needsRestart: boolean;
  readonly locked: boolean;
  readonly startDate: LocalDate;
}

/**
 * Period, N, K, start date and prerequisite of a habit change only before its run begins — a future start date, or
 * locked, since a locked habit's run starts when it unlocks — or at a restart (Q-37, Q-38).
 */
export function habitStructureEditable(habit: HabitEditFacts, today: LocalDate): boolean {
  return habit.needsRestart || habit.locked || daysBetween(today, habit.startDate) > 0;
}

/** A locked habit never resets; its run starts on the unlock day if its start date has passed by then (Q-38). */
export function habitStartOnUnlock(startDate: LocalDate, unlockDay: LocalDate): LocalDate {
  return fromDayNumber(Math.max(toDayNumber(startDate), toDayNumber(unlockDay)));
}

/**
 * A completed quest keeps its target values (A-37): lowering or raising them afterwards could make it incomplete
 * again and re-lock a running habit that requires it, which would stop that habit's periods (Q-38).
 */
export function targetValuesEditable(quest: { readonly completed: boolean }): boolean {
  return !quest.completed;
}
