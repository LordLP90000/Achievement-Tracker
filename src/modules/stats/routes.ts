import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { Problems } from '../../platform/http/problem.ts';
import { parseRequest, ProblemError } from '../../platform/http/validation.ts';
import { principalOf } from '../sessions/guard.ts';
import type { Stats, StatsService } from './service.ts';

/** `GET /me/stats` of `openapi/openapi.yaml` (tag `stats`), mounted under `/v1` behind the auth guard. */

export interface StatsRoutesOptions {
  readonly stats: StatsService;
}

/** No XP predates 1970; earlier dates would only meet the limits of the calendars (dates.ts, PostgreSQL) (A-43). */
export const EARLIEST_STATS_DATE = '1970-01-01';

const statsDate = z.iso.date().refine((date) => date >= EARLIEST_STATS_DATE, 'must not be before 1970-01-01');

const statsQuery = z.object({ from: statsDate.optional(), to: statsDate.optional() });

/** `Stats`. */
function statsJson(stats: Stats) {
  return {
    xp_total: stats.xpTotal,
    level: stats.level,
    xp_to_next_level: stats.xpToNextLevel,
    xp_by_day: stats.xpByDay.map(({ date, xp }) => ({ date, xp })),
    achievements: {
      active: stats.achievements.active,
      paused: stats.achievements.paused,
      completed: stats.achievements.completed,
      completed_by_rank: stats.achievements.completedByRank,
    },
    badges: stats.badges.map((badge) => ({
      id: badge.id,
      kind: badge.kind,
      rank: badge.rank,
      achievement_id: badge.achievementId,
      achievement_title: badge.achievementTitle,
      awarded_at: badge.awardedAt.toISOString(),
    })),
    best_streaks: stats.bestStreaks.map((streak) => ({
      quest_id: streak.questId,
      quest_title: streak.questTitle,
      period: streak.period,
      best: streak.best,
      current: streak.current,
    })),
    gambles: { won: stats.gambles.won, lost: stats.gambles.lost },
  };
}

export const statsRoutes: FastifyPluginCallback<StatsRoutesOptions> = (app, { stats }, done) => {
  app.get('/me/stats', async (request) => {
    const query = parseRequest(statsQuery, request.query);
    const result = await stats.get(principalOf(request), { from: query.from ?? null, to: query.to ?? null });
    if (result.outcome === 'invalid_range') {
      throw new ProblemError({ ...Problems.validation, errors: [{ pointer: '/from', message: result.message }] });
    }
    return statsJson(result.stats);
  });

  done();
};
