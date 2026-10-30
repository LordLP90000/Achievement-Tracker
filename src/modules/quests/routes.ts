import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { etagOf } from '../../platform/http/concurrency.ts';
import { idempotentRequest, sendIdempotent } from '../../platform/http/idempotency.ts';
import { limitReached, Problems, unprocessable } from '../../platform/http/problem.ts';
import { boundedText, isUuidV4, parseRequest, ProblemError } from '../../platform/http/validation.ts';
import { questJson } from '../goals/representations.ts';
import { principalOf } from '../sessions/guard.ts';
import { QUEST_LIMIT, type CreateQuestRefusal, type QuestsService } from './service.ts';

/** Quest endpoints of `openapi/openapi.yaml` (tag `quests`), mounted under `/v1` behind the auth guard. */

export interface QuestsRoutesOptions {
  readonly quests: QuestsService;
}

/** Contract `Decimal`: at most 10 digits before and 3 after the point; the ±10^9 bound is a rule (422, A-05). */
const decimal = z.string().regex(/^-?\d{1,10}(?:\.\d{1,3})?$/);
const uuid = z.string().refine((value) => isUuidV4(value));

const habitConfig = z.strictObject({
  period: z.enum(['day', 'week']),
  times_per_period: z.number().int().min(1).max(50),
  period_count: z.number().int().min(1).max(520),
  start_date: z.iso.date().optional(),
});

const targetConfig = z.strictObject({
  start_value: decimal,
  target_value: decimal,
  unit: boundedText(0, 20).optional(),
});

/** `QuestCreate`: XP, state, progress, resets and timestamps never come from the client (R-AUTHZ-04). */
const questCreate = z.strictObject({
  title: boundedText(1, 120),
  notes: boundedText(0, 2000).optional(),
  type: z.enum(['one_time', 'habit', 'target']),
  size: z.enum(['S', 'M', 'L']),
  is_required: z.boolean().optional(),
  position: z.number().int().min(0).max(1000).optional(),
  prerequisite_quest_id: uuid.optional(),
  habit: habitConfig.optional(),
  target: targetConfig.optional(),
});

const LIMIT_REACHED = limitReached(`At most ${String(QUEST_LIMIT)} quests per achievement`);

function problemOf(refusal: CreateQuestRefusal) {
  switch (refusal.outcome) {
    case 'consent_required':
      return Problems.consentRequired;
    case 'not_found':
      return Problems.notFound;
    case 'achievement_completed':
      return Problems.achievementCompleted;
    case 'limit_reached':
      return LIMIT_REACHED;
    case 'invalid':
      return unprocessable(refusal.pointer, refusal.message);
  }
}

export const questsRoutes: FastifyPluginCallback<QuestsRoutesOptions> = (app, { quests }, done) => {
  // The contract documents no 400 for path IDs: an ID that cannot exist is simply not found.
  const notFound = () => new ProblemError(Problems.notFound);

  app.get<{ Params: { achievementId: string } }>('/achievements/:achievementId/quests', async (request) => {
    const { achievementId } = request.params;
    const views = isUuidV4(achievementId) ? await quests.list(principalOf(request), achievementId) : undefined;
    if (views === undefined) throw notFound();
    return { items: views.map(questJson) };
  });

  app.post<{ Params: { achievementId: string } }>('/achievements/:achievementId/quests', async (request, reply) => {
    const { achievementId } = request.params;
    if (!isUuidV4(achievementId)) throw notFound();
    const body = parseRequest(questCreate, request.body);
    const idempotency = idempotentRequest(
      'createQuest',
      request.headers['idempotency-key'],
      request.params,
      request.body,
    );
    const input = {
      title: body.title,
      notes: body.notes ?? null,
      type: body.type,
      size: body.size,
      isRequired: body.is_required ?? true,
      position: body.position ?? null,
      prerequisiteQuestId: body.prerequisite_quest_id ?? null,
      habit:
        body.habit === undefined
          ? null
          : {
              period: body.habit.period,
              timesPerPeriod: body.habit.times_per_period,
              periodCount: body.habit.period_count,
              startDate: body.habit.start_date ?? null,
            },
      target:
        body.target === undefined
          ? null
          : { start: body.target.start_value, target: body.target.target_value, unit: body.target.unit ?? null },
    };
    const result = await quests.create(principalOf(request), achievementId, input, idempotency, (created) => ({
      status: 201,
      headers: { etag: etagOf(created.record.version), location: `/v1/quests/${created.record.id}` },
      body: questJson(created),
    }));
    if (result.outcome === 'refused') throw new ProblemError(problemOf(result.refusal));
    return sendIdempotent(reply, result);
  });

  app.get<{ Params: { questId: string } }>('/quests/:questId', async (request, reply) => {
    const { questId } = request.params;
    const view = isUuidV4(questId) ? await quests.get(principalOf(request), questId) : undefined;
    if (view === undefined) throw notFound();
    return reply.header('etag', etagOf(view.record.version)).send(questJson(view));
  });

  done();
};
