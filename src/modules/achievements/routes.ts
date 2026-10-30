import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { etagOf, requireIfMatch } from '../../platform/http/concurrency.ts';
import { idempotentRequest, sendIdempotent } from '../../platform/http/idempotency.ts';
import { pageParams } from '../../platform/http/pagination.ts';
import { limitReached, Problems, type ProblemDefinition } from '../../platform/http/problem.ts';
import { boundedText, isUuidV4, parseRequest, ProblemError } from '../../platform/http/validation.ts';
import {
  achievementDetailJson,
  achievementJson,
  achievementViewJson,
  NEW_ACHIEVEMENT,
} from '../goals/representations.ts';
import { principalOf } from '../sessions/guard.ts';
import {
  ACHIEVEMENT_LIMIT,
  type AchievementChangeRefusal,
  type AchievementEdit,
  type AchievementsService,
} from './service.ts';

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

/** `AchievementUpdate`: `completed` is the system's (R-ACH-07); null clears an optional field. */
const achievementUpdate = z
  .strictObject({
    title: boundedText(1, 120).optional(),
    description: boundedText(0, 2000).nullable().optional(),
    motivation: boundedText(0, 2000).nullable().optional(),
    category: boundedText(0, 60).nullable().optional(),
    target_date: z.iso.date().nullable().optional(),
    is_private: z.boolean().optional(),
    status: z.enum(['active', 'paused']).optional(),
  })
  .refine((update) => Object.keys(update).length > 0, {
    message: 'needs at least one property',
    when: (payload) => payload.issues.length === 0,
  });

/** The edit as the service takes it: only what the request names (`exactOptionalPropertyTypes`). */
const editOf = (body: z.output<typeof achievementUpdate>): AchievementEdit => ({
  ...(body.title === undefined ? {} : { title: body.title }),
  ...(body.description === undefined ? {} : { description: body.description }),
  ...(body.motivation === undefined ? {} : { motivation: body.motivation }),
  ...(body.category === undefined ? {} : { category: body.category }),
  ...(body.target_date === undefined ? {} : { targetDate: body.target_date }),
  ...(body.is_private === undefined ? {} : { isPrivate: body.is_private }),
  ...(body.status === undefined ? {} : { status: body.status }),
});

function problemOf(refusal: AchievementChangeRefusal): ProblemDefinition {
  switch (refusal.outcome) {
    case 'not_found':
      return Problems.notFound;
    case 'achievement_completed':
      return Problems.achievementCompleted;
    case 'gamble_pending':
      return Problems.gamblePending;
    case 'version_conflict':
      return { ...Problems.versionConflict, extensions: { current_version: refusal.currentVersion } };
  }
}

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

  app.patch<{ Params: { achievementId: string } }>('/achievements/:achievementId', async (request, reply) => {
    const { achievementId } = request.params;
    if (!isUuidV4(achievementId)) throw new ProblemError(Problems.notFound);
    const expectedVersion = requireIfMatch(request.headers['if-match']);
    const edit = editOf(parseRequest(achievementUpdate, request.body));
    const result = await achievements.update(principalOf(request), achievementId, expectedVersion, edit);
    if (result.outcome !== 'updated') throw new ProblemError(problemOf(result));
    return reply.header('etag', etagOf(result.view.record.version)).send(achievementViewJson(result.view));
  });

  app.delete<{ Params: { achievementId: string } }>('/achievements/:achievementId', async (request, reply) => {
    const { achievementId } = request.params;
    if (!isUuidV4(achievementId)) throw new ProblemError(Problems.notFound);
    const expectedVersion = requireIfMatch(request.headers['if-match']);
    const result = await achievements.delete(principalOf(request), achievementId, expectedVersion);
    if (result.outcome !== 'deleted') throw new ProblemError(problemOf(result));
    return reply.code(204).send();
  });

  done();
};
