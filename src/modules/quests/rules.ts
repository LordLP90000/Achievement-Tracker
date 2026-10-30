import { daysBetween, type LocalDate } from '../../domain/dates.ts';
import { formatDecimal, parseDecimal } from '../../domain/decimal.ts';
import type { HabitPeriod, QuestSize } from '../../domain/duration.ts';
import type { WeekStart } from '../../domain/periods.ts';
import type { QuestEvaluation } from '../../domain/quest-evaluation.ts';
import { checkPrerequisite, habitStructureEditable, targetValuesEditable } from '../../domain/transitions.ts';
import type { EditedQuest, HabitSettings, QuestRecord, QuestType, TargetSettings } from './repository.ts';

/**
 * The rules a quest request must keep beyond its schema (`422`, contract `UnprocessableContent`): type settings
 * (R-QST-03…05), start dates (A-28), values (A-05), prerequisites (R-QST-02, A-16), and what an edit may change
 * (R-QST-07, Q-37, Q-38, Q-41, A-37, A-39, A-41). Messages are static and never echo a value.
 */

export interface HabitInput {
  readonly period: HabitPeriod;
  readonly timesPerPeriod: number;
  readonly periodCount: number;
  /** Omitted: today in a create and at a restart, otherwise the stored date (Q-41). */
  readonly startDate: LocalDate | null;
}

/** A new quest as the client describes it (contract `QuestCreate`). */
export interface QuestInput {
  readonly title: string;
  readonly notes: string | null;
  readonly type: QuestType;
  readonly size: QuestSize;
  readonly isRequired: boolean;
  /** Last when omitted. */
  readonly position: number | null;
  readonly prerequisiteQuestId: string | null;
  readonly habit: HabitInput | null;
  readonly target: { readonly start: string; readonly target: string; readonly unit: string | null } | null;
}

/** An edit as the client sends it (contract `QuestUpdate`): only what it names changes. */
export interface QuestEdit {
  readonly title?: string;
  readonly notes?: string | null;
  readonly size?: QuestSize;
  readonly isRequired?: boolean;
  readonly position?: number;
  readonly prerequisiteQuestId?: string | null;
  readonly habit?: HabitInput;
  /** An omitted unit stays, null removes it (Q-41). */
  readonly target?: { readonly start: string; readonly target: string; readonly unit?: string | null };
}

/** A rule the request breaks (`422`), with a JSON pointer into the request. */
export interface RuleViolation {
  readonly outcome: 'invalid';
  readonly pointer: string;
  readonly message: string;
}

const violation = (pointer: string, message: string): RuleViolation => ({ outcome: 'invalid', pointer, message });

const isViolation = (value: object | null): value is RuleViolation => value !== null && 'outcome' in value;

const PAST_START = 'must be today or later: back-dated check-ins never count';
const OUT_OF_RANGE = 'must lie within ±1000000000';
const FIXED_WHILE_RUNNING = 'cannot change while the habit runs or after it completed, only before or at a restart';

/** Stands for the quest being created in prerequisite checks; never a UUID, so never an existing quest. */
const NEW_QUEST = 'new-quest';

/** Thousandths of a decimal within ±10^9 (A-05), or null beyond it. */
function decimalOf(text: string): number | null {
  try {
    return parseDecimal(text);
  } catch {
    return null;
  }
}

/** Start and target value in thousandths, within ±10^9 and different (A-05, R-QST-05). */
function targetValues(input: { readonly start: string; readonly target: string }) {
  const start = decimalOf(input.start);
  if (start === null) return violation('/target/start_value', OUT_OF_RANGE);
  const target = decimalOf(input.target);
  if (target === null) return violation('/target/target_value', OUT_OF_RANGE);
  if (start === target) return violation('/target/target_value', 'must differ from start_value');
  return { start, target };
}

/** May the quest require `prerequisiteId`, among the quests of its achievement (R-QST-02, A-16)? */
function prerequisiteViolation(
  questId: string,
  prerequisiteId: string,
  quests: readonly QuestRecord[],
): RuleViolation | null {
  const links = new Map(quests.map((quest) => [quest.id, quest.prerequisiteQuestId]));
  switch (checkPrerequisite(questId, prerequisiteId, links)) {
    case null:
      return null;
    case 'unknown':
      return violation('/prerequisite_quest_id', 'is not a quest of this achievement');
    case 'cycle':
      return violation('/prerequisite_quest_id', 'would make a cycle');
    case 'too_deep':
      return violation('/prerequisite_quest_id', 'would make a chain of more than 20 quests');
  }
}

/** The first rule a new quest breaks, or null; `existing` are the quests of its achievement. */
export function createViolation(
  input: QuestInput,
  today: LocalDate,
  existing: readonly QuestRecord[],
): RuleViolation | null {
  if ((input.type === 'habit') !== (input.habit !== null)) {
    return violation('/habit', input.type === 'habit' ? 'is required for a habit quest' : 'is only for habit quests');
  }
  if ((input.type === 'target') !== (input.target !== null)) {
    return violation(
      '/target',
      input.type === 'target' ? 'is required for a target quest' : 'is only for target quests',
    );
  }
  const startDate = input.habit?.startDate ?? null;
  if (startDate !== null && daysBetween(today, startDate) < 0) return violation('/habit/start_date', PAST_START);
  if (input.target !== null) {
    const values = targetValues(input.target);
    if (isViolation(values)) return values;
  }
  return input.prerequisiteQuestId === null
    ? null
    : prerequisiteViolation(NEW_QUEST, input.prerequisiteQuestId, existing);
}

/** A quest as the goal engine sees it today, with what an edit needs to know about its achievement. */
export interface EditContext {
  readonly quest: QuestRecord;
  readonly evaluation: QuestEvaluation;
  /** No habit run is going while the achievement is paused (A-39). */
  readonly paused: boolean;
  /** The quests of the achievement, the edited one included. */
  readonly quests: readonly QuestRecord[];
  readonly today: LocalDate;
  /** The account's week start, which a run defined anew takes (A-41). */
  readonly weekStart: WeekStart;
}

export type EditResult = { readonly outcome: 'edited'; readonly quest: EditedQuest } | RuleViolation;

/** The habit settings after the edit; at a restart (R-QST-04) or before its run begins only (Q-37). */
function editedHabit(
  input: HabitInput | undefined,
  context: EditContext,
  runFixed: boolean,
): HabitSettings | null | RuleViolation {
  const { quest, today } = context;
  const stored = quest.habit;
  if (input === undefined || stored === null) return stored;
  const restart = quest.needsRestart;
  const startDate = input.startDate ?? (restart ? today : stored.startDate);
  const unchanged =
    !restart &&
    input.period === stored.period &&
    input.timesPerPeriod === stored.timesPerPeriod &&
    input.periodCount === stored.periodCount &&
    startDate === stored.startDate;
  if (unchanged) return stored;
  if (runFixed) return violation('/habit', FIXED_WHILE_RUNNING);
  if ((restart || startDate !== stored.startDate) && daysBetween(today, startDate) < 0) {
    return violation('/habit/start_date', PAST_START);
  }
  // The edit defines the run anew, so it takes the account's week start as a new habit would (A-41, Q-34).
  const { period, timesPerPeriod, periodCount } = input;
  return { period, timesPerPeriod, periodCount, startDate, weekStart: context.weekStart };
}

/** The target settings after the edit: a completed quest keeps its values (A-37), its unit may change. */
function editedTarget(input: QuestEdit['target'], context: EditContext): TargetSettings | null | RuleViolation {
  const stored = context.quest.target;
  if (input === undefined || stored === null) return stored;
  const values = targetValues(input);
  if (isViolation(values)) return values;
  if (!targetValuesEditable(context.evaluation)) {
    const fixed = 'cannot change once the quest is completed';
    if (values.start !== parseDecimal(stored.start)) return violation('/target/start_value', fixed);
    if (values.target !== parseDecimal(stored.target)) return violation('/target/target_value', fixed);
  }
  const unit = input.unit === undefined ? stored.unit : input.unit;
  return { start: formatDecimal(values.start), target: formatDecimal(values.target), unit };
}

/** The quest as the edit leaves it, or the first rule the edit breaks. */
export function applyEdit(edit: QuestEdit, context: EditContext): EditResult {
  const { quest, today } = context;
  if (edit.habit !== undefined && quest.habit === null) return violation('/habit', 'is only for habit quests');
  if (edit.target !== undefined && quest.target === null) return violation('/target', 'is only for target quests');
  // A habit's run is fixed once it began — unless it is locked or paused, which holds it, or awaits a restart.
  const locked = context.evaluation.state === 'locked' || context.paused;
  const runFixed =
    quest.habit !== null &&
    !habitStructureEditable({ needsRestart: quest.needsRestart, locked, startDate: quest.habit.startDate }, today);
  const habit = editedHabit(edit.habit, context, runFixed);
  if (isViolation(habit)) return habit;
  const target = editedTarget(edit.target, context);
  if (isViolation(target)) return target;
  const prerequisiteQuestId =
    edit.prerequisiteQuestId === undefined ? quest.prerequisiteQuestId : edit.prerequisiteQuestId;
  if (prerequisiteQuestId !== quest.prerequisiteQuestId) {
    // Like the run itself: otherwise a new prerequisite could freeze a habit just before a missed period (Q-38).
    if (runFixed) return violation('/prerequisite_quest_id', FIXED_WHILE_RUNNING);
    const broken =
      prerequisiteQuestId === null ? null : prerequisiteViolation(quest.id, prerequisiteQuestId, context.quests);
    if (broken !== null) return broken;
  }
  return {
    outcome: 'edited',
    quest: {
      position: edit.position ?? quest.position,
      size: edit.size ?? quest.size,
      isRequired: edit.isRequired ?? quest.isRequired,
      prerequisiteQuestId,
      title: edit.title ?? quest.title,
      notes: edit.notes === undefined ? quest.notes : edit.notes,
      habit,
      target,
      // New habit settings restart a habit that awaits it (R-QST-04).
      needsRestart: quest.needsRestart && edit.habit === undefined,
    },
  };
}
