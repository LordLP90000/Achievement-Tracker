import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { etagOf, requireIfMatch } from '../../platform/http/concurrency.ts';
import { idempotentRequest, sendIdempotent } from '../../platform/http/idempotency.ts';
import { limitReached, Problems, unprocessable, type ProblemDefinition } from '../../platform/http/problem.ts';
import {
  boundedText,
  decimalText as decimal,
  isUuidV4,
  parseRequest,
  ProblemError,
} from '../../platform/http/validation.ts';
import { effectsJson, questJson } from '../goals/representations.ts';
import { principalOf } from '../sessions/guard.ts';
import type { HabitInput, QuestEdit } from './rules.ts';
import { QUEST_LIMIT, type CreateQuestRefusal, type QuestChangeRefusal, type QuestsService } from './service.ts';

/** Quest endpoints of `openapi/openapi.yaml` (tag `quests`), mounted under `/v1` behind the auth guard. */

export interface QuestsRoutesOptions {
  readonly quests: QuestsService;
}

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

/** `QuestUpdate`: the type never changes (R-QST-07); null clears notes, the prerequisite and the unit (Q-41). */
const questUpdate = z
  .strictObject({
    title: boundedText(1, 120).optional(),
    notes: boundedText(0, 2000).nullable().optional(),
    size: z.enum(['S', 'M', 'L']).optional(),
    is_required: z.boolean().optional(),
    position: z.number().int().min(0).max(1000).optional(),
    prerequisite_quest_id: uuid.nullable().optional(),
    habit: habitConfig.optional(),
    target: targetConfig.extend({ unit: boundedText(0, 20).nullable().optional() }).optional(),
  })
  .refine((update) => Object.keys(update).length > 0, {
    message: 'needs at least one property',
    when: (payload) => payload.issues.length === 0,
  });

const LIMIT_REACHED = limitReached(`At most ${String(QUEST_LIMIT)} quests per achievement`);

type HabitConfig = z.output<typeof habitConfig>;

const habitInputOf = (habit: HabitConfig): HabitInput => ({
  period: habit.period,
  timesPerPeriod: habit.times_per_period,
  periodCount: habit.period_count,
  startDate: habit.start_date ?? null,
});

/** The edit as the service takes it: only what the request names (`exactOptionalPropertyTypes`). */
function editOf(body: z.output<typeof questUpdate>): QuestEdit {
  const { target } = body;
  return {
    ...(body.title === undefined ? {} : { title: body.title }),
    ...(body.notes === undefined ? {} : { notes: body.notes }),
    ...(body.size === undefined ? {} : { size: body.size }),
    ...(body.is_required === undefined ? {} : { isRequired: body.is_required }),
    ...(body.position === undefined ? {} : { position: body.position }),
    ...(body.prerequisite_quest_id === undefined ? {} : { prerequisiteQuestId: body.prerequisite_quest_id }),
    ...(body.habit === undefined ? {} : { habit: habitInputOf(body.habit) }),
    ...(target === undefined
      ? {}
      : {
          target: {
            start: target.start_value,
            target: target.target_value,
            ...(target.unit === undefined ? {} : { unit: target.unit }),
          },
        }),
  };
}

function problemOf(refusal: CreateQuestRefusal | QuestChangeRefusal): ProblemDefinition {
  switch (refusal.outcome) {
    case 'consent_required':
      return Problems.consentRequired;
    case 'not_found':
      return Problems.notFound;
    case 'achievement_completed':
      return Problems.achievementCompleted;
    case 'version_conflict':
      return { ...Problems.versionConflict, extensions: { current_version: refusal.currentVersion } };
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
      habit: body.habit === undefined ? null : habitInputOf(body.habit),
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

  app.patch<{ Params: { questId: string } }>('/quests/:questId', async (request, reply) => {
    const { questId } = request.params;
    if (!isUuidV4(questId)) throw notFound();
    const expectedVersion = requireIfMatch(request.headers['if-match']);
    const edit = editOf(parseRequest(questUpdate, request.body));
    const result = await quests.update(principalOf(request), questId, expectedVersion, edit);
    if (result.outcome !== 'updated') throw new ProblemError(problemOf(result));
    return reply.header('etag', etagOf(result.quest.record.version)).send(effectsJson(result.quest, result.effects));
  });

  app.delete<{ Params: { questId: string } }>('/quests/:questId', async (request) => {
    const { questId } = request.params;
    if (!isUuidV4(questId)) throw notFound();
    const expectedVersion = requireIfMatch(request.headers['if-match']);
    const result = await quests.delete(principalOf(request), questId, expectedVersion);
    if (result.outcome !== 'deleted') throw new ProblemError(problemOf(result));
    return effectsJson(null, result.effects);
  });

  done();
};
