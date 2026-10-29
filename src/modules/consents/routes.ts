import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import { Problems } from '../../platform/http/problem.ts';
import { parseRequest, ProblemError } from '../../platform/http/validation.ts';
import { requestContext } from '../audit/context.ts';
import { principalOf } from '../sessions/guard.ts';
import type { ConsentRecord } from './repository.ts';
import type { ConsentsService } from './service.ts';

/** Consent endpoints of `openapi/openapi.yaml` (tag `consents`), mounted under `/v1` behind the auth guard. */

export interface ConsentsRoutesOptions {
  readonly consents: ConsentsService;
}

const CONSENT_TYPES = ['goal_content'] as const;

const grantRequest = z.strictObject({ type: z.enum(CONSENT_TYPES), version: z.iso.date() });

/** `Consent` in the contract. */
const consentJson = (consent: ConsentRecord) => ({
  type: consent.type,
  version: consent.version,
  granted_at: consent.grantedAt.toISOString(),
  withdrawn_at: consent.withdrawnAt?.toISOString() ?? null,
});

export const consentsRoutes: FastifyPluginCallback<ConsentsRoutesOptions> = (app, { consents }, done) => {
  app.get('/me/consents', async (request) => ({
    items: (await consents.list(principalOf(request))).map(consentJson),
  }));

  app.post('/me/consents', async (request, reply) => {
    const { type, version } = parseRequest(grantRequest, request.body);
    const result = await consents.grant(principalOf(request), type, version, requestContext(request));
    if (result.outcome === 'already_granted') throw new ProblemError(Problems.consentAlreadyGranted);
    return reply.code(201).send(consentJson(result.consent));
  });

  app.delete<{ Params: { type: string } }>('/me/consents/:type', async (request, reply) => {
    const type = CONSENT_TYPES.find((known) => known === request.params.type);
    const withdrawn =
      type !== undefined && (await consents.withdraw(principalOf(request), type, requestContext(request)));
    if (!withdrawn) throw new ProblemError(Problems.notFound);
    return reply.code(204).send();
  });

  done();
};
