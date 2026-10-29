import type { FastifyPluginCallback } from 'fastify';
import { Problems } from '../../platform/http/problem.ts';
import { parseRequest, ProblemError } from '../../platform/http/validation.ts';
import { requestContext } from '../audit/context.ts';
import { enforce, limitMailTo } from '../rate-limit/http.ts';
import { BACKOFFS, type RateLimiter } from '../rate-limit/limiter.ts';
import { principalOf } from '../sessions/guard.ts';
import type { PasswordsService } from './password-service.ts';
import { ACCEPTED } from './routes.ts';
import { changePasswordRequest, emailRequest, resetPasswordRequest } from './schemas.ts';

/** Password endpoints of `openapi/openapi.yaml`, mounted under `/v1` behind the auth guard. */

export interface PasswordRoutesOptions {
  readonly passwords: PasswordsService;
  readonly limiter: RateLimiter;
}

/** `security: []` in the contract. */
const PUBLIC = { config: { public: true } };

/** Authenticated and documenting `429`: limited per user as well. */
const USER_LIMITED = { config: { userRateLimit: true } };

const CHANGE_FAILURES = {
  reauthentication_required: Problems.reauthenticationRequired,
  wrong_password: Problems.invalidCredentials,
  weak_password: Problems.weakPassword,
} as const;

const RESET_FAILURES = {
  invalid_token: Problems.invalidToken,
  weak_password: Problems.weakPassword,
} as const;

export const passwordRoutes: FastifyPluginCallback<PasswordRoutesOptions> = (app, { passwords, limiter }, done) => {
  app.post('/me/password', USER_LIMITED, async (request, reply) => {
    const body = parseRequest(changePasswordRequest, request.body);
    const principal = principalOf(request);
    const backoff = BACKOFFS.userPassword;
    await enforce(limiter.blocked(backoff, principal.userId), request, backoff.scope);
    const result = await passwords.change(
      principal,
      { current: body.current_password, next: body.new_password },
      requestContext(request),
    );
    // Only an answer about the current password counts for the backoff.
    if (result !== 'reauthentication_required') {
      await limiter.record(backoff, principal.userId, result !== 'wrong_password');
    }
    if (result !== 'changed') throw new ProblemError(CHANGE_FAILURES[result]);
    return reply.code(204).send();
  });

  app.post('/auth/password/forgot', PUBLIC, async (request, reply) => {
    const { email } = parseRequest(emailRequest, request.body);
    await limitMailTo(limiter, request, email);
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
