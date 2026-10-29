import type { FastifyPluginCallback } from 'fastify';
import { Problems } from '../../platform/http/problem.ts';
import { parseRequest, ProblemError } from '../../platform/http/validation.ts';
import { requestContext } from '../audit/context.ts';
import { enforce } from '../rate-limit/http.ts';
import { LIMITS, type RateLimiter } from '../rate-limit/limiter.ts';
import { principalOf } from '../sessions/guard.ts';
import type { EmailChangeService } from './email-change-service.ts';
import { ACCEPTED } from './routes.ts';
import { emailChangeRequest, tokenRequest } from './schemas.ts';

/** Email-change endpoints of `openapi/openapi.yaml`, mounted under `/v1` behind the auth guard. */

export interface EmailChangeRoutesOptions {
  readonly emailChanges: EmailChangeService;
  readonly limiter: RateLimiter;
}

/** `security: []` in the contract. */
const PUBLIC = { config: { public: true } };

/** Authenticated and documenting `429`: limited per user as well. */
const USER_LIMITED = { config: { userRateLimit: true } };

const CONFIRM_FAILURES = {
  invalid_token: Problems.invalidToken,
  email_taken: Problems.emailTaken,
} as const;

export const emailChangeRoutes: FastifyPluginCallback<EmailChangeRoutesOptions> = (
  app,
  { emailChanges, limiter },
  done,
) => {
  app.post('/me/email-change', USER_LIMITED, async (request, reply) => {
    const { new_email: newEmail } = parseRequest(emailChangeRequest, request.body);
    const principal = principalOf(request);
    await enforce(limiter.take(LIMITS.userMail, principal.userId), request, LIMITS.userMail.scope);
    const result = await emailChanges.request(principal, newEmail, requestContext(request));
    if (result === 'reauthentication_required') throw new ProblemError(Problems.reauthenticationRequired);
    return reply.code(202).send(ACCEPTED);
  });

  app.post('/me/email-change/confirm', PUBLIC, async (request, reply) => {
    const { token } = parseRequest(tokenRequest, request.body);
    const result = await emailChanges.confirm(token, requestContext(request));
    if (result !== 'changed') throw new ProblemError(CONFIRM_FAILURES[result]);
    return reply.code(204).send();
  });

  done();
};
