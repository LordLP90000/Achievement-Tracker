import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { idempotentRequest, sendIdempotent } from '../../platform/http/idempotency.ts';
import { pageParams } from '../../platform/http/pagination.ts';
import { Problems, type ProblemDefinition } from '../../platform/http/problem.ts';
import { isUuidV4, parseRequest, ProblemError } from '../../platform/http/validation.ts';
import { gambleJson } from '../goals/representations.ts';
import { principalOf } from '../sessions/guard.ts';
import type { GamblesService, PlaceGambleRefusal } from './service.ts';

/** Gamble endpoints of `openapi/openapi.yaml` (tag `gambles`), mounted under `/v1` behind the auth guard. */

export interface GamblesRoutesOptions {
  readonly gambles: GamblesService;
}

/** `GamblePlaceRequest`: empty or omitted — the stake and everything else is the server's (R-AUTHZ-04, T-17). */
const placeRequest = z.strictObject({}).optional();

const listQuery = z.object({ ...pageParams });

const PROBLEMS: Readonly<Record<PlaceGambleRefusal, ProblemDefinition>> = {
  not_found: Problems.notFound,
  'achievement-not-active': Problems.achievementNotActive,
  'gamble-target-date-required': Problems.gambleTargetDateRequired,
  'gamble-pending': Problems.gamblePending,
  'gamble-lost-this-attempt': Problems.gambleLostThisAttempt,
  'nothing-to-stake': Problems.nothingToStake,
};

export const gamblesRoutes: FastifyPluginCallback<GamblesRoutesOptions> = (app, { gambles }, done) => {
  // The contract documents no 400 for path IDs: an ID that cannot exist is simply not found.
  const notFound = () => new ProblemError(Problems.notFound);

  app.get<{ Params: { achievementId: string } }>('/achievements/:achievementId/gambles', async (request) => {
    const { achievementId } = request.params;
    if (!isUuidV4(achievementId)) throw notFound();
    const query = parseRequest(listQuery, request.query);
    const page = await gambles.list(principalOf(request), achievementId, {
      after: query.cursor ?? null,
      limit: query.limit,
    });
    if (page === undefined) throw notFound();
    return { items: page.items.map(gambleJson), next_cursor: page.nextCursor };
  });

  app.post<{ Params: { achievementId: string } }>('/achievements/:achievementId/gambles', async (request, reply) => {
    const { achievementId } = request.params;
    if (!isUuidV4(achievementId)) throw notFound();
    parseRequest(placeRequest, request.body);
    const idempotency = idempotentRequest(
      'placeGamble',
      request.headers['idempotency-key'],
      request.params,
      request.body,
    );
    const result = await gambles.place(principalOf(request), achievementId, idempotency, (placed) => ({
      status: 201,
      headers: {},
      body: gambleJson(placed),
    }));
    if (result.outcome === 'refused') throw new ProblemError(PROBLEMS[result.refusal]);
    return sendIdempotent(reply, result);
  });

  done();
};
