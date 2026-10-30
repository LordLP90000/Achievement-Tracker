import type { LocalDate } from '../../domain/dates.ts';
import { parseDecimal } from '../../domain/decimal.ts';
import {
  deleteQuestEffects,
  reconcile,
  type AchievementFacts,
  type Outcome,
  type QuestFacts,
  type XpEventDraft,
  type XpEventKind,
} from '../../domain/effects.ts';
import type { WeekStart } from '../../domain/periods.ts';
import {
  evaluateQuest,
  summarizeAchievement,
  type CountingCheckIn,
  type QuestDefinition,
  type QuestEvaluation,
} from '../../domain/quest-evaluation.ts';
import { habitStartOnUnlock } from '../../domain/transitions.ts';
import type { DataKeys } from '../../platform/crypto/data-keys.ts';
import { inTransaction, type Database, type Transaction } from '../../platform/db/database.ts';
import { transactionLock } from '../../platform/db/locks.ts';
import type { Clock } from '../../platform/time/clock.ts';
import { localDateOf } from '../../platform/time/time-zones.ts';
import { withUserDataKey, type UserDataKey } from '../accounts/data-key.ts';
import { requireAccountClock } from '../accounts/repository.ts';
import {
  achievementsRepository,
  type AchievementRecord,
  type AchievementsRepository,
} from '../achievements/repository.ts';
import { checkInsRepository, type CountingCheckInRecord } from '../check-ins/repository.ts';
import { gambleFacts, settleGamble } from '../gambles/repository.ts';
import { questsRepository, type HabitSettings, type QuestRecord, type QuestStateChange } from '../quests/repository.ts';
import {
  appendXpEvents,
  awardRankBadge,
  gambleWinPaid,
  ledgerFacts,
  removeRankBadge,
  type LedgerFacts,
} from './ledger-repository.ts';

/**
 * The goal engine (R-XP-01, R-ACH-04…07, R-QST-04, Q-38, A-21, T-06). Every goal operation runs through it, in one
 * transaction under the user's lock: it evaluates an achievement's quests for today in the account's time zone,
 * stores what the evaluation found (habit resets, runs moved to the unlock day, completion), lets the effects engine
 * (`src/domain/effects.ts`) reconcile XP, unlock and gambles, and stores that outcome as well.
 */

export interface GoalDependencies {
  readonly db: Database;
  readonly dataKeys: DataKeys;
  readonly clock: Clock;
}

export interface GoalScope {
  readonly tx: Transaction;
  readonly userId: string;
  readonly dataKey: UserDataKey;
  readonly now: Date;
  readonly timeZone: string;
  /** Today in the account's time zone (ADR-0011). */
  readonly today: LocalDate;
  /** The account's week start, for runs that start now (Q-34). */
  readonly weekStart: WeekStart;
}

export interface QuestView {
  readonly record: QuestRecord;
  readonly evaluation: QuestEvaluation;
}

export interface AchievementView {
  readonly record: AchievementRecord;
  /** In their order: position, then creation. */
  readonly quests: readonly QuestView[];
  readonly progress: number;
  readonly xpRequiredTotal: number;
  /** What the achievement credits in the current attempt, quests and rank bonus (contract `xp_earned`). */
  readonly xpEarned: number;
}

export interface GoalSync {
  readonly view: AchievementView;
  /** What reconciliation changed; null for a paused achievement, which nothing changes. */
  readonly outcome: Outcome | null;
  /** The user's XP total afterwards. */
  readonly totalXp: number;
}

export interface SyncOptions {
  /**
   * Quests that were locked before the change being synced (a new or removed prerequisite, a deleted one): a habit
   * among them that is unlocked now starts its run today if its start date has passed (Q-38).
   */
  readonly lockedBefore?: ReadonlySet<string>;
}

/** What a change did (contract `Effects`): the achievement afterwards and the outcomes of the syncs around it. */
export interface GoalEffects {
  readonly view: AchievementView;
  /** In order; a change reports what the sync before it found as well (a reset, a lost gamble, A-21). */
  readonly outcomes: readonly Outcome[];
  readonly totalXp: number;
}

export function effectsOf(before: GoalSync, after: GoalSync): GoalEffects {
  return {
    view: after.view,
    outcomes: [before.outcome, after.outcome].filter((outcome) => outcome !== null),
    totalXp: after.totalXp,
  };
}

/** The quests a view shows as locked, for the sync after a change (Q-38). */
export const lockedQuestsOf = (view: AchievementView): ReadonlySet<string> =>
  new Set(view.quests.filter((quest) => quest.evaluation.state === 'locked').map((quest) => quest.record.id));

/** A transaction bound to the user (RLS) under their goal lock, with their data key and their today. */
export function withGoals<T>(
  deps: GoalDependencies,
  userId: string,
  work: (scope: GoalScope) => Promise<T>,
): Promise<T> {
  return inTransaction(deps.db, (tx) =>
    withUserDataKey(tx, deps.dataKeys, userId, async (dataKey) => {
      // One goal operation of a user at a time — API and worker alike — so totals and gambles stay consistent.
      await transactionLock(tx, `goals:${userId}`);
      const account = await requireAccountClock(tx, userId);
      const now = deps.clock.now();
      return work({
        tx,
        userId,
        dataKey,
        now,
        timeZone: account.timeZone,
        today: localDateOf(now, account.timeZone),
        weekStart: account.weekStart,
      });
    }),
  );
}

/**
 * Active achievements live; completed ones as of their unlock day, the read-only archive (R-ACH-07); paused ones as
 * reset (R-ACH-06): no check-in counts and no habit run has started.
 */
type Mode = 'live' | 'archive' | 'paused';

interface Evaluated extends QuestView {
  /** What to store: a reset, a run moved to the unlock day, a change of completion. */
  readonly change: QuestStateChange;
}

const EARNED_KINDS: ReadonlySet<XpEventKind> = new Set([
  'quest_completed',
  'quest_uncompleted',
  'rank_bonus',
  'rank_bonus_revoked',
]);

function definitionOf(quest: QuestRecord, habit: HabitSettings | null): QuestDefinition {
  if (quest.target !== null) {
    return { type: 'target', start: parseDecimal(quest.target.start), target: parseDecimal(quest.target.target) };
  }
  if (habit !== null) {
    return { type: 'habit', ...habit, needsRestart: quest.needsRestart, bestOfEndedRuns: quest.habitBestStreak };
  }
  return { type: 'one_time' };
}

const countingOf = (records: readonly CountingCheckInRecord[] = []): CountingCheckIn[] =>
  records.map((record) => ({
    localDate: record.localDate,
    createdAtMs: record.createdAt.getTime(),
    value: record.value === null ? null : parseDecimal(record.value),
  }));

/** Evaluates the quests in prerequisite order: a quest is locked while its prerequisite is not complete (R-QST-02). */
function evaluateQuests(
  quests: readonly QuestRecord[],
  counting: ReadonlyMap<string, readonly CountingCheckInRecord[]>,
  day: LocalDate,
  mode: Mode,
  scope: GoalScope,
  lockedBefore: ReadonlySet<string>,
): Evaluated[] {
  const byId = new Map(quests.map((quest) => [quest.id, quest]));
  const evaluated = new Map<string, Evaluated>();
  const visiting = new Set<string>();

  const evaluate = (quest: QuestRecord): Evaluated => {
    const known = evaluated.get(quest.id);
    if (known !== undefined) return known;
    visiting.add(quest.id);
    const prerequisite = quest.prerequisiteQuestId === null ? undefined : byId.get(quest.prerequisiteQuestId);
    // A stored cycle (refused on every write, A-16) unlocks nothing.
    const prerequisiteDone =
      prerequisite === undefined || (!visiting.has(prerequisite.id) && evaluate(prerequisite).evaluation.completed);
    // Q-38: a habit unlocked now — its prerequisite completes now, or the change being synced unlocked it — starts its
    // run today, or on its later start date.
    const unlocking =
      mode === 'live' && prerequisiteDone && (lockedBefore.has(quest.id) || prerequisite?.completedAt === null);
    const unlockStart =
      unlocking && quest.habit !== null && !quest.needsRestart ? habitStartOnUnlock(quest.habit.startDate, day) : null;
    const moved = unlockStart !== null && unlockStart !== quest.habit?.startDate;
    const habit =
      quest.habit === null
        ? null
        : mode === 'paused'
          ? { ...quest.habit, startDate: habitStartOnUnlock(quest.habit.startDate, day) }
          : moved
            ? { ...quest.habit, startDate: unlockStart, weekStart: scope.weekStart }
            : quest.habit;
    const evaluation = evaluateQuest(
      {
        size: quest.size,
        definition: definitionOf(quest, habit),
        checkIns: countingOf(counting.get(quest.id)),
        locked: !prerequisiteDone,
      },
      day,
    );
    const completionChanged = mode !== 'paused' && evaluation.completed !== (quest.completedAt !== null);
    // Only a quest being deleted is missing from its achievement: its dependents no longer require it (R-QST-08).
    const detached = quest.prerequisiteQuestId !== null && prerequisite === undefined;
    const change: QuestStateChange = {
      ...(mode === 'live' && evaluation.reset !== null
        ? { needsRestart: true, resetCount: quest.resetCount + 1, habitBestStreak: evaluation.reset.bestOfEndedRuns }
        : {}),
      ...(moved && habit !== null
        ? {
            habitStartDate: habit.startDate,
            // Daily runs have no week start (data-model §3.3).
            ...(habit.period === 'week' ? { habitWeekStart: habit.weekStart } : {}),
          }
        : {}),
      ...(completionChanged ? { completedAt: evaluation.completed ? scope.now : null } : {}),
      ...(detached ? { prerequisiteQuestId: null } : {}),
    };
    const result = { record: quest, evaluation, change };
    visiting.delete(quest.id);
    evaluated.set(quest.id, result);
    return result;
  };

  return quests.map(evaluate);
}

async function storeQuestChanges(scope: GoalScope, quests: readonly Evaluated[]): Promise<Evaluated[]> {
  const repository = questsRepository(scope.tx, scope.userId, scope.dataKey);
  const stored: Evaluated[] = [];
  for (const quest of quests) {
    const changed = Object.keys(quest.change).length > 0;
    stored.push(
      changed ? { ...quest, record: await repository.updateState(quest.record, quest.change, scope.now) } : quest,
    );
  }
  return stored;
}

async function storeCompletion(
  scope: GoalScope,
  achievements: AchievementsRepository,
  achievement: AchievementRecord,
  outcome: Outcome,
): Promise<AchievementRecord> {
  if (outcome.unlock !== null) {
    await awardRankBadge(scope.tx, scope.userId, achievement.id, outcome.unlock.rank, scope.now);
    const { score, rank } = outcome.unlock;
    const unlocked = { status: 'completed', completedAt: scope.now, executionScore: score, rank } as const;
    return achievements.updateCompletion(achievement, unlocked, scope.now);
  }
  if (outcome.relocked) {
    await removeRankBadge(scope.tx, scope.userId, achievement.id);
    const relocked = { status: 'active', completedAt: null, executionScore: null, rank: null } as const;
    return achievements.updateCompletion(achievement, relocked, scope.now);
  }
  return achievement;
}

function viewOf(
  achievement: AchievementRecord,
  quests: readonly Evaluated[],
  ledger: LedgerFacts,
  events: readonly XpEventDraft[],
): AchievementView {
  const summary = summarizeAchievement(
    quests.map(({ record, evaluation }) => ({
      isRequired: record.isRequired,
      xp: evaluation.xp,
      progress: evaluation.progress,
    })),
  );
  const credited = quests.reduce(
    (sum, { record }) => sum + (ledger.questCredits.get(record.id) ?? 0),
    ledger.rankBonusCredited,
  );
  const added = events.filter((event) => EARNED_KINDS.has(event.kind)).reduce((sum, event) => sum + event.amount, 0);
  return {
    record: achievement,
    quests: quests.map(({ record, evaluation }) => ({ record, evaluation })),
    progress: summary.progress,
    xpRequiredTotal: summary.xpRequiredTotal,
    xpEarned: credited + added,
  };
}

/** Evaluates the achievement now and stores what follows from it; with `deleting`, as if that quest were gone. */
async function settle(
  scope: GoalScope,
  achievementId: string,
  options: SyncOptions & { readonly deleting?: QuestRecord },
): Promise<GoalSync | undefined> {
  const { tx, userId, dataKey } = scope;
  const { deleting } = options;
  const achievements = achievementsRepository(tx, userId, dataKey);
  const achievement = await achievements.find(achievementId);
  if (achievement === undefined) return undefined;
  const records = await questsRepository(tx, userId, dataKey).listByAchievement(achievement.id);
  // The ledger is read with the deleted quest, whose credit the deletion revokes (Q-12).
  const ledger = await ledgerFacts(
    tx,
    userId,
    achievement.id,
    records.map((quest) => quest.id),
  );
  const kept = records.filter((quest) => quest.id !== deleting?.id);
  const keptIds = kept.map((quest) => quest.id);
  const mode: Mode =
    achievement.status === 'active' ? 'live' : achievement.status === 'completed' ? 'archive' : 'paused';
  if (deleting !== undefined && mode === 'archive') throw new Error('a completed achievement is read-only');
  const day = mode === 'archive' ? localDateOf(achievement.completedAt ?? scope.now, scope.timeZone) : scope.today;
  const counting =
    mode === 'paused'
      ? new Map<string, CountingCheckInRecord[]>()
      : await checkInsRepository(tx, userId, dataKey).countingByQuest(keptIds, achievement.attempt);
  const evaluated = evaluateQuests(kept, counting, day, mode, scope, options.lockedBefore ?? new Set());
  const quests = await storeQuestChanges(scope, evaluated);
  if (mode === 'paused' && deleting === undefined) {
    return { view: viewOf(achievement, quests, ledger, []), outcome: null, totalXp: ledger.totalXp };
  }

  const gambles = await gambleFacts(tx, userId, achievement.id, achievement.attempt);
  const targetDate = achievement.targetDate;
  const facts: AchievementFacts = {
    status: achievement.status,
    attempt: achievement.attempt,
    createdAtMs: achievement.createdAt.getTime(),
    deadline: achievement.deadline,
    rankBonusCredited: ledger.rankBonusCredited,
    lostGambles: gambles.lost,
    // A gamble is placed only with a target date, which cannot change while it is pending (R-GMB-01, A-26).
    pendingGamble: gambles.pending === null || targetDate === null ? null : { ...gambles.pending, targetDate },
    wonGamble:
      gambles.won === null ? null : { id: gambles.won.id, paid: await gambleWinPaid(tx, userId, gambles.won.id) },
  };
  const questFacts: QuestFacts[] = quests.map(({ record, evaluation }) => ({
    id: record.id,
    isRequired: record.isRequired,
    xp: evaluation.xp,
    resetCount: record.resetCount,
    completed: evaluation.completed,
    credited: ledger.questCredits.get(record.id) ?? 0,
  }));
  const habitReset = quests.some((quest) => quest.change.needsRestart === true);
  const context = { nowMs: scope.now.getTime(), today: day, totalXp: ledger.totalXp };
  const outcome =
    deleting === undefined
      ? reconcile(facts, questFacts, context, { habitReset })
      : deleteQuestEffects(
          facts,
          [...questFacts, deletedQuestFacts(deleting, ledger.questCredits.get(deleting.id) ?? 0)],
          deleting.id,
          context,
          { habitReset },
        );

  await appendXpEvents(tx, userId, achievement.id, outcome.events, scope.today, scope.now);
  const stored = await storeCompletion(scope, achievements, achievement, outcome);
  if (outcome.gamble !== null) await settleGamble(tx, userId, outcome.gamble, scope.now);
  // Last, so the revocation above still names the quest; its check-ins go with it, its ledger events stay (R-XP-01).
  if (deleting !== undefined) await questsRepository(tx, userId, dataKey).remove(deleting.id);
  return { view: viewOf(stored, quests, ledger, outcome.events), outcome, totalXp: outcome.totalXp };
}

/** A quest being deleted deserves nothing any more: what the ledger credits it is revoked (Q-12). */
const deletedQuestFacts = (quest: QuestRecord, credited: number): QuestFacts => ({
  id: quest.id,
  isRequired: quest.isRequired,
  xp: 0,
  resetCount: quest.resetCount,
  completed: false,
  credited,
});

/**
 * Evaluates the achievement now and stores what follows from it; undefined unless it is the user's. Idempotent:
 * a second call without a change in between finds nothing left to do.
 */
export function syncAchievement(
  scope: GoalScope,
  achievementId: string,
  options: SyncOptions = {},
): Promise<GoalSync | undefined> {
  return settle(scope, achievementId, options);
}

/**
 * Deletes a quest of an active or paused achievement (R-QST-08, Q-12): revokes what it credits, reconciles the rest —
 * deleting the last open required quest unlocks the achievement — detaches the quests that required it, and deletes
 * it with its check-ins. Sync the achievement first, in the same transaction, to check the request against it.
 */
export async function deleteQuest(scope: GoalScope, quest: QuestRecord, options: SyncOptions = {}): Promise<GoalSync> {
  const synced = await settle(scope, quest.achievementId, { ...options, deleting: quest });
  if (synced === undefined) throw new Error('the achievement of the quest to delete is gone');
  return synced;
}
