import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { idempotentRequest, sendIdempotent } from '../../platform/http/idempotency.ts';
import { pageParams } from '../../platform/http/pagination.ts';
import { limitReached, Problems, unprocessable, type ProblemDefinition } from '../../platform/http/problem.ts';
import { boundedText, decimalText, isUuidV4, parseRequest, ProblemError } from '../../platform/http/validation.ts';
import { checkInJson, checkInResultJson, effectsJson } from '../goals/representations.ts';
import { principalOf } from '../sessions/guard.ts';
import { CHECK_INS_PER_DAY, type CheckInsService, type CreateCheckInRefusal } from './service.ts';

/** Check-in endpoints of `openapi/openapi.yaml` (tag `check-ins`), mounted under `/v1` behind the auth guard. */

export interface CheckInsRoutesOptions {
  readonly checkIns: CheckInsService;
}

/** `CheckInCreate`: whether it counts, its attempt and its time are the server's (R-CHK-04, R-AUTHZ-04). */
const checkInCreate = z.strictObject({
  local_date: z.iso.date(),
  value: decimalText.optional(),
  note: boundedText(0, 500).optional(),
});

const listQuery = z.object({ ...pageParams });

const LIMIT_REACHED = limitReached(`At most ${String(CHECK_INS_PER_DAY)} check-ins per quest and day`);

function problemOf(refusal: CreateCheckInRefusal): ProblemDefinition {
  switch (refusal.outcome) {
    case 'consent_required':
      return Problems.consentRequired;
    case 'not_found':
      return Problems.notFound;
    case 'achievement_not_active':
      return Problems.achievementNotActive;
    case 'quest_completed':
      return Problems.questCompleted;
    case 'quest_needs_restart':
      return Problems.questNeedsRestart;
    case 'quest_locked':
      return Problems.questLocked;
    case 'limit_reached':
      return LIMIT_REACHED;
    case 'invalid':
      return unprocessable(refusal.pointer, refusal.message);
  }
}

export const checkInsRoutes: FastifyPluginCallback<CheckInsRoutesOptions> = (app, { checkIns }, done) => {
  // The contract documents no 400 for path IDs: an ID that cannot exist is simply not found.
  const notFound = () => new ProblemError(Problems.notFound);

  app.get<{ Params: { questId: string } }>('/quests/:questId/check-ins', async (request) => {
    const { questId } = request.params;
    if (!isUuidV4(questId)) throw notFound();
    const query = parseRequest(listQuery, request.query);
    const page = await checkIns.list(principalOf(request), questId, {
      after: query.cursor ?? null,
      limit: query.limit,
    });
    if (page === undefined) throw notFound();
    return { items: page.items.map(checkInJson), next_cursor: page.nextCursor };
  });

  app.post<{ Params: { questId: string } }>('/quests/:questId/check-ins', async (request, reply) => {
    const { questId } = request.params;
    if (!isUuidV4(questId)) throw notFound();
    const body = parseRequest(checkInCreate, request.body);
    const idempotency = idempotentRequest(
      'createCheckIn',
      request.headers['idempotency-key'],
      request.params,
      request.body,
    );
    const input = { localDate: body.local_date, value: body.value ?? null, note: body.note ?? null };
    const result = await checkIns.create(principalOf(request), questId, input, idempotency, (created) => ({
      status: 201,
      headers: { location: `/v1/check-ins/${created.checkIn.id}` },
      body: checkInResultJson(created.checkIn, created.quest, created.effects),
    }));
    if (result.outcome === 'refused') throw new ProblemError(problemOf(result.refusal));
    return sendIdempotent(reply, result);
  });

  app.delete<{ Params: { checkInId: string } }>('/check-ins/:checkInId', async (request) => {
    const { checkInId } = request.params;
    if (!isUuidV4(checkInId)) throw notFound();
    const result = await checkIns.undo(principalOf(request), checkInId);
    switch (result.outcome) {
      case 'not_found':
        throw notFound();
      case 'check_in_final':
        throw new ProblemError(Problems.checkInFinal);
      case 'gamble_pending':
        throw new ProblemError(Problems.gamblePending);
      case 'undone':
        return effectsJson(result.quest, result.effects);
    }
  });

  done();
};
