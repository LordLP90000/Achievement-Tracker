import { RANK_MULTIPLIERS, type Rank } from '../../domain/constants.ts';
import { addDays, daysBetween, type LocalDate } from '../../domain/dates.ts';
import type { HabitPeriod } from '../../domain/duration.ts';
import { topStreaks } from '../../domain/streak.ts';
import { levelForXp, xpToNextLevel } from '../../domain/xp.ts';
import {
  restingHabitQuests,
  syncAchievement,
  withGoals,
  type GoalDependencies,
  type QuestView,
} from '../goals/engine.ts';
import { changingAchievements } from '../goals/evaluation-repository.ts';
import { totalXp } from '../goals/ledger-repository.ts';
import type { Principal } from '../sessions/guard.ts';
import {
  achievementCounts,
  gambleRecord,
  newestBadges,
  xpByDay,
  type BadgeView,
  type StatusCount,
} from './repository.ts';

/** R-STA-01: XP over time, level, achievements by status and rank, badges, best streaks, gamble record. */

/** Without `from`, the series starts this many days before `to` (contract `getStats`). */
export const DEFAULT_SPAN_DAYS = 30;
/** Days in the longest series (contract `Stats.xp_by_day.maxItems`). */
export const MAX_SERIES_DAYS = 366;
export const MAX_BADGES = 200;
export const MAX_STREAKS = 20;

export interface StatsRange {
  readonly from: LocalDate | null;
  /** Today in the account's time zone when null. */
  readonly to: LocalDate | null;
}

export interface StreakView {
  readonly questId: string;
  readonly questTitle: string;
  readonly period: HabitPeriod;
  readonly best: number;
  readonly current: number;
}

export interface Stats {
  readonly xpTotal: number;
  readonly level: number;
  readonly xpToNextLevel: number;
  /** Every local day from `from` to `to`, a day without XP at 0 (A-43). */
  readonly xpByDay: readonly { readonly date: LocalDate; readonly xp: number }[];
  readonly achievements: {
    readonly active: number;
    readonly paused: number;
    readonly completed: number;
    readonly completedByRank: Readonly<Record<Rank, number>>;
  };
  readonly badges: readonly BadgeView[];
  readonly bestStreaks: readonly StreakView[];
  readonly gambles: { readonly won: number; readonly lost: number };
}

export type StatsResult =
  | { readonly outcome: 'stats'; readonly stats: Stats }
  /** About `from`, the date a client may move. */
  | { readonly outcome: 'invalid_range'; readonly message: string };

export interface StatsService {
  get(principal: Principal, range: StatsRange): Promise<StatsResult>;
}

const RANKS = Object.keys(RANK_MULTIPLIERS) as Rank[];

/** Habits with a met period, as `GET /quests/{id}` shows their streak (R-STR-01, A-43). */
function streaksOf(quests: readonly QuestView[]): StreakView[] {
  return quests.flatMap(({ record, evaluation }) =>
    record.habit === null || evaluation.streak === null || evaluation.streak.best === 0
      ? []
      : [{ questId: record.id, questTitle: record.title, period: record.habit.period, ...evaluation.streak }],
  );
}

function achievementsOf(counts: readonly StatusCount[]): Stats['achievements'] {
  const counted = (status: StatusCount['status'], rank?: Rank) =>
    counts
      .filter((row) => row.status === status && (rank === undefined || row.rank === rank))
      .reduce((total, row) => total + row.count, 0);
  const completedByRank = Object.fromEntries(RANKS.map((rank) => [rank, counted('completed', rank)]));
  return {
    active: counted('active'),
    paused: counted('paused'),
    completed: counted('completed'),
    completedByRank: completedByRank as Record<Rank, number>,
  };
}

export function createStatsService(deps: GoalDependencies): StatsService {
  return {
    get(principal, range) {
      return withGoals(deps, principal.userId, async (scope): Promise<StatsResult> => {
        const to = range.to ?? scope.today;
        const from = range.from ?? addDays(to, -DEFAULT_SPAN_DAYS);
        const days = daysBetween(from, to) + 1;
        if (days < 1) return { outcome: 'invalid_range', message: 'must not be after to' };
        if (days > MAX_SERIES_DAYS) {
          return { outcome: 'invalid_range', message: `must be at most ${String(MAX_SERIES_DAYS - 1)} days before to` };
        }
        const { tx, userId } = scope;

        // As of now, as every read (A-21): what time alone changed — a missed period, a passed target date — is stored
        // first, so the totals include it. Everything else is evaluated as it stands.
        const habits: QuestView[] = [];
        for (const achievementId of await changingAchievements(tx, userId)) {
          habits.push(...((await syncAchievement(scope, achievementId))?.view.quests ?? []));
        }
        habits.push(...(await restingHabitQuests(scope)));

        const total = await totalXp(tx, userId);
        const daily = await xpByDay(tx, userId, from, to);
        return {
          outcome: 'stats',
          stats: {
            xpTotal: total,
            level: levelForXp(total),
            xpToNextLevel: xpToNextLevel(total),
            xpByDay: Array.from({ length: days }, (_, offset) => {
              const date = addDays(from, offset);
              return { date, xp: daily.get(date) ?? 0 };
            }),
            achievements: achievementsOf(await achievementCounts(tx, userId)),
            badges: await newestBadges(tx, userId, scope.dataKey, MAX_BADGES),
            bestStreaks: topStreaks(streaksOf(habits), MAX_STREAKS),
            gambles: await gambleRecord(tx, userId),
          },
        };
      });
    },
  };
}
