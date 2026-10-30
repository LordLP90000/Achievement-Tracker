import type { LocalDate } from './dates.ts';
import {
  revertWin,
  settleAsLost,
  settleOnUnlock,
  targetDatePassed,
  type AchievementStatus,
  type GambleLossReason,
  type Settlement,
} from './gamble.ts';
import { executionScore, isFlawless, rankBonus, rankForScore, type Rank, type ScoredQuest } from './rank.ts';

/**
 * The effects engine (R-XP-01, R-ACH-04…06, R-ACH-09, R-QST-08, R-GMB-02/03, ADR-0015). Every path that can change
 * XP — check-in, undo, quest edit, pause, deletion, the daily job — compares what the ledger credits with what the
 * state deserves and appends only the difference. Each path is therefore idempotent, and an undo is the exact
 * inverse of its check-in, by construction. The service persists the outcome in one transaction under row locks.
 */

export type XpEventKind =
  | 'quest_completed'
  | 'quest_uncompleted'
  | 'rank_bonus'
  | 'rank_bonus_revoked'
  | 'gamble_won'
  | 'gamble_lost'
  | 'gamble_reverted'
  | 'pause_revoked'
  | 'quest_deleted'
  | 'achievement_deleted'
  | 'xp_floor';

export interface XpEventDraft {
  readonly kind: XpEventKind;
  readonly amount: number;
  readonly questId: string | null;
  readonly gambleId: string | null;
}

export interface QuestFacts extends ScoredQuest {
  readonly id: string;
  /** XP the ledger credits to this quest in the current attempt. */
  readonly credited: number;
}

/** The achievement's pending gamble; its target date cannot change while it is pending (A-26). */
export interface PendingGamble {
  readonly id: string;
  readonly stake: number;
  readonly targetDate: LocalDate;
}

/** The gamble won by the achievement's current unlock, and what the win paid. */
export interface WonGamble {
  readonly id: string;
  readonly paid: number;
}

export interface AchievementFacts {
  readonly status: AchievementStatus;
  readonly attempt: number;
  readonly createdAtMs: number;
  /** The attempt's deadline (A-35). */
  readonly deadline: LocalDate | null;
  readonly rankBonusCredited: number;
  /** Gambles lost on this achievement so far, in any attempt. */
  readonly lostGambles: number;
  readonly pendingGamble: PendingGamble | null;
  readonly wonGamble: WonGamble | null;
}

export interface EffectContext {
  readonly nowMs: number;
  /** Today in the account's time zone. */
  readonly today: LocalDate;
  /** The account's XP total before the change. */
  readonly totalXp: number;
}

export interface GambleEffect {
  readonly id: string;
  readonly outcome: 'won' | 'lost' | 'reverted';
  readonly xpDelta: number;
  readonly lossReason: GambleLossReason | null;
}

export interface Outcome {
  readonly events: readonly XpEventDraft[];
  readonly status: AchievementStatus;
  /** Set when this change unlocked the achievement: persist rank, score, `completed_at` and the badge. */
  readonly unlock: { readonly score: number; readonly rank: Rank } | null;
  /** This change re-locked the achievement: remove rank, score, `completed_at` and the badge (R-ACH-05). */
  readonly relocked: boolean;
  readonly gamble: GambleEffect | null;
  readonly totalXp: number;
}

interface Ledger {
  readonly events: XpEventDraft[];
  total: number;
}

function add(
  ledger: Ledger,
  kind: XpEventKind,
  amount: number,
  ids: { readonly questId?: string; readonly gambleId?: string } = {},
): void {
  if (amount === 0) return;
  ledger.events.push({ kind, amount, questId: ids.questId ?? null, gambleId: ids.gambleId ?? null });
  ledger.total += amount;
}

/** Books a settlement and reports it as the contract's `GambleOutcome`. */
function book(ledger: Ledger, gambleId: string, settlement: Settlement): GambleEffect {
  const kinds = { won: 'gamble_won', lost: 'gamble_lost', reverted: 'gamble_reverted' } as const;
  add(ledger, kinds[settlement.outcome], settlement.xpDelta, { gambleId });
  const lossReason = settlement.outcome === 'lost' ? settlement.lossReason : null;
  return { id: gambleId, outcome: settlement.outcome, xpDelta: settlement.xpDelta, lossReason };
}

type Change = Omit<Outcome, 'events' | 'totalXp'>;

/**
 * R-XP-04, A-38: the total never goes below 0. Revocations are exact, so it could only dip below 0 when a lost gamble
 * took XP that is later revoked; a floor adjustment then brings it back to 0.
 */
function finish(ledger: Ledger, change: Change): Outcome {
  add(ledger, 'xp_floor', Math.max(0, -ledger.total));
  return { ...change, events: ledger.events, totalXp: ledger.total };
}

function reconcileInto(
  ledger: Ledger,
  achievement: AchievementFacts,
  quests: readonly QuestFacts[],
  context: EffectContext,
  habitReset: boolean,
): Change {
  let gamble: GambleEffect | null = null;
  let lostGambles = achievement.lostGambles;
  let pending = achievement.pendingGamble;
  // A pending gamble is lost first, on the total before this change, as the daily job would have (A-20, A-21).
  if (pending !== null) {
    const reason = habitReset
      ? 'habit_reset'
      : targetDatePassed(pending.targetDate, context.today)
        ? 'target_date_passed'
        : null;
    if (reason !== null) {
      gamble = book(ledger, pending.id, settleAsLost(pending.stake, ledger.total, reason));
      pending = null;
      lostGambles += 1;
    }
  }
  for (const quest of quests) {
    const difference = (quest.completed ? quest.xp : 0) - quest.credited;
    add(ledger, 'quest_completed', Math.max(0, difference), { questId: quest.id });
    add(ledger, 'quest_uncompleted', Math.min(0, difference), { questId: quest.id });
  }
  const required = quests.filter((quest) => quest.isRequired);
  const allRequiredDone = required.length > 0 && required.every((quest) => quest.completed);
  if (achievement.status === 'active' && allRequiredDone) {
    const facts = { quests, deadline: achievement.deadline, unlockDate: context.today, lostGambles };
    const score = executionScore(facts);
    const rank = rankForScore(score, isFlawless({ ...facts, attempt: achievement.attempt }));
    const achievementAgeMs = context.nowMs - achievement.createdAtMs;
    const requiredXp = required.reduce((sum, quest) => sum + quest.xp, 0);
    add(ledger, 'rank_bonus', rankBonus(requiredXp, rank, achievementAgeMs));
    if (pending !== null) {
      const unlock = { date: context.today, requiredXp, achievementAgeMs, totalXp: ledger.total };
      gamble = book(ledger, pending.id, settleOnUnlock(pending, unlock));
    }
    return { status: 'completed', unlock: { score, rank }, relocked: false, gamble };
  }
  if (achievement.status === 'completed' && !allRequiredDone) {
    add(ledger, 'rank_bonus_revoked', -achievement.rankBonusCredited);
    const won = achievement.wonGamble;
    if (won !== null) gamble = book(ledger, won.id, revertWin(won.paid));
    return { status: 'active', unlock: null, relocked: true, gamble };
  }
  return { status: achievement.status, unlock: null, relocked: false, gamble };
}

/**
 * After a check-in, an undo, a quest edit or the daily job: quest XP follows completion; a pending gamble is lost
 * once its target date has passed or a habit of the achievement reset; the achievement unlocks when every required
 * quest is complete (score, rank, rank bonus, a pending gamble won) and re-locks when an undo makes one incomplete.
 */
export function reconcile(
  achievement: AchievementFacts,
  quests: readonly QuestFacts[],
  context: EffectContext,
  options: { readonly habitReset?: boolean } = {},
): Outcome {
  const ledger: Ledger = { events: [], total: context.totalXp };
  return finish(ledger, reconcileInto(ledger, achievement, quests, context, options.habitReset === true));
}

/** Pausing resets the attempt (R-ACH-06): a pending gamble is lost, then all XP of the attempt is revoked. */
export function pauseEffects(
  achievement: AchievementFacts,
  quests: readonly QuestFacts[],
  context: EffectContext,
): Outcome {
  const ledger: Ledger = { events: [], total: context.totalXp };
  const pending = achievement.pendingGamble;
  const gamble =
    pending === null ? null : book(ledger, pending.id, settleAsLost(pending.stake, ledger.total, 'paused'));
  for (const quest of quests) add(ledger, 'pause_revoked', -quest.credited, { questId: quest.id });
  return finish(ledger, { status: 'paused', unlock: null, relocked: false, gamble });
}

/**
 * Deleting a quest revokes its XP (Q-12, R-QST-08); the remaining quests are reconciled first, so deleting the last
 * open required quest unlocks the achievement.
 */
export function deleteQuestEffects(
  achievement: AchievementFacts,
  quests: readonly QuestFacts[],
  deletedQuestId: string,
  context: EffectContext,
  options: { readonly habitReset?: boolean } = {},
): Outcome {
  const ledger: Ledger = { events: [], total: context.totalXp };
  const remaining = quests.filter((quest) => quest.id !== deletedQuestId);
  const change = reconcileInto(ledger, achievement, remaining, context, options.habitReset === true);
  for (const deleted of quests.filter((quest) => quest.id === deletedQuestId)) {
    add(ledger, 'quest_deleted', -deleted.credited, { questId: deleted.id });
  }
  return finish(ledger, change);
}

/** Deleting an active or paused achievement loses its pending gamble and revokes all its XP (R-ACH-09, Q-12). */
export function deleteAchievementEffects(
  achievement: AchievementFacts,
  quests: readonly QuestFacts[],
  context: EffectContext,
): Outcome {
  const ledger: Ledger = { events: [], total: context.totalXp };
  const pending = achievement.pendingGamble;
  const gamble =
    pending === null ? null : book(ledger, pending.id, settleAsLost(pending.stake, ledger.total, 'deleted'));
  for (const quest of quests) add(ledger, 'achievement_deleted', -quest.credited, { questId: quest.id });
  return finish(ledger, { status: achievement.status, unlock: null, relocked: false, gamble });
}
