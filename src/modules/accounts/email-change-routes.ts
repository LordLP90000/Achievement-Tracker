import type { FastifyPluginCallback } from 'fastify';
import { Problems } from '../../platform/http/problem.ts';
import { parseRequest, ProblemError } from '../../platform/http/validation.ts';
import { requestContext } from '../audit/context.ts';
import { principalOf } from '../sessions/guard.ts';
import type { EmailChangeService } from './email-change-service.ts';
import { ACCEPTED } from './routes.ts';
import { emailChangeRequest, tokenRequest } from './schemas.ts';

/** Email-change endpoints of `openapi/openapi.yaml`, mounted under `/v1` behind the auth guard. */

export interface EmailChangeRoutesOptions {
  readonly emailChanges: EmailChangeService;
}

/** `security: []` in the contract. */
const PUBLIC = { config: { public: true } };

const CONFIRM_FAILURES = {
  invalid_token: Problems.invalidToken,
  email_taken: Problems.emailTaken,
} as const;

export const emailChangeRoutes: FastifyPluginCallback<EmailChangeRoutesOptions> = (app, { emailChanges }, done) => {
  app.post('/me/email-change', async (request, reply) => {
    const { new_email: newEmail } = parseRequest(emailChangeRequest, request.body);
    const result = await emailChanges.request(principalOf(request), newEmail, requestContext(request));
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
