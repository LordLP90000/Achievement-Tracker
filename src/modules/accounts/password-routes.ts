import type { FastifyPluginCallback } from 'fastify';
import { Problems } from '../../platform/http/problem.ts';
import { parseRequest, ProblemError } from '../../platform/http/validation.ts';
import { requestContext } from '../audit/context.ts';
import { principalOf } from '../sessions/guard.ts';
import type { PasswordsService } from './password-service.ts';
import { ACCEPTED } from './routes.ts';
import { changePasswordRequest, emailRequest, resetPasswordRequest } from './schemas.ts';

/** Password endpoints of `openapi/openapi.yaml`, mounted under `/v1` behind the auth guard. */

export interface PasswordRoutesOptions {
  readonly passwords: PasswordsService;
}

/** `security: []` in the contract. */
const PUBLIC = { config: { public: true } };

const CHANGE_FAILURES = {
  reauthentication_required: Problems.reauthenticationRequired,
  wrong_password: Problems.invalidCredentials,
  weak_password: Problems.weakPassword,
} as const;

const RESET_FAILURES = {
  invalid_token: Problems.invalidToken,
  weak_password: Problems.weakPassword,
} as const;

export const passwordRoutes: FastifyPluginCallback<PasswordRoutesOptions> = (app, { passwords }, done) => {
  app.post('/me/password', async (request, reply) => {
    const body = parseRequest(changePasswordRequest, request.body);
    const result = await passwords.change(
      principalOf(request),
      { current: body.current_password, next: body.new_password },
      requestContext(request),
    );
    if (result !== 'changed') throw new ProblemError(CHANGE_FAILURES[result]);
    return reply.code(204).send();
  });

  app.post('/auth/password/forgot', PUBLIC, async (request, reply) => {
    const { email } = parseRequest(emailRequest, request.body);
    await passwords.requestReset(email, requestContext(request));
    return reply.code(202).send(ACCEPTED);
  });

  app.post('/auth/password/reset', PUBLIC, async (request, reply) => {
    const body = parseRequest(resetPasswordRequest, request.body);
    const result = await passwords.reset(body.token, body.new_password, requestContext(request));
    if (result !== 'reset') throw new ProblemError(RESET_FAILURES[result]);
    return reply.code(204).send();
  });

  done();
};
