import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { etagOf } from '../../platform/http/concurrency.ts';
import { idempotentRequest, sendIdempotent } from '../../platform/http/idempotency.ts';
import { pageParams } from '../../platform/http/pagination.ts';
import { limitReached, Problems } from '../../platform/http/problem.ts';
import { boundedText, isUuidV4, parseRequest, ProblemError } from '../../platform/http/validation.ts';
import {
  achievementDetailJson,
  achievementJson,
  achievementViewJson,
  NEW_ACHIEVEMENT,
} from '../goals/representations.ts';
import { principalOf } from '../sessions/guard.ts';
import { ACHIEVEMENT_LIMIT, type AchievementsService } from './service.ts';

/** Achievement endpoints of `openapi/openapi.yaml` (tag `achievements`), mounted under `/v1` behind the auth guard. */

export interface AchievementsRoutesOptions {
  readonly achievements: AchievementsService;
}

const STATUSES = ['active', 'paused', 'completed'] as const;

/** `AchievementCreate`: status, attempt, XP, rank and timestamps never come from the client (R-AUTHZ-04). */
const achievementCreate = z.strictObject({
  title: boundedText(1, 120),
  description: boundedText(0, 2000).optional(),
  motivation: boundedText(0, 2000).optional(),
  category: boundedText(0, 60).optional(),
  target_date: z.iso.date().optional(),
  is_private: z.boolean().optional(),
});

const listQuery = z.object({ status: z.enum(STATUSES).optional(), ...pageParams });

const LIMIT_REACHED = limitReached(`At most ${String(ACHIEVEMENT_LIMIT)} active or paused achievements`);

export const achievementsRoutes: FastifyPluginCallback<AchievementsRoutesOptions> = (app, { achievements }, done) => {
  app.get('/achievements', async (request) => {
    const query = parseRequest(listQuery, request.query);
    const page = await achievements.list(principalOf(request), {
      status: query.status,
      after: query.cursor ?? null,
      limit: query.limit,
    });
    return { items: page.items.map(achievementViewJson), next_cursor: page.nextCursor };
  });

  app.post('/achievements', async (request, reply) => {
    const body = parseRequest(achievementCreate, request.body);
    const idempotency = idempotentRequest(
      'createAchievement',
      request.headers['idempotency-key'],
      request.params,
      request.body,
    );
    const content = {
      title: body.title,
      description: body.description ?? null,
      motivation: body.motivation ?? null,
      category: body.category ?? null,
      targetDate: body.target_date ?? null,
      isPrivate: body.is_private ?? false,
    };
    const result = await achievements.create(principalOf(request), content, idempotency, (created) => ({
      status: 201,
      headers: { etag: etagOf(created.version), location: `/v1/achievements/${created.id}` },
      body: achievementJson(created, NEW_ACHIEVEMENT),
    }));
    if (result.outcome === 'consent_required') throw new ProblemError(Problems.consentRequired);
    if (result.outcome === 'limit_reached') throw new ProblemError(LIMIT_REACHED);
    return sendIdempotent(reply, result);
  });

  app.get<{ Params: { achievementId: string } }>('/achievements/:achievementId', async (request, reply) => {
    const { achievementId } = request.params;
    // The contract documents no 400 here: an ID that cannot exist is simply not found.
    const view = isUuidV4(achievementId) ? await achievements.get(principalOf(request), achievementId) : undefined;
    if (view === undefined) throw new ProblemError(Problems.notFound);
    return reply.header('etag', etagOf(view.record.version)).send(achievementDetailJson(view));
  });

  done();
};
