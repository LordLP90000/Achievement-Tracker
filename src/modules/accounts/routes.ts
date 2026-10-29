import type { FastifyPluginCallback } from 'fastify';
import { Problems } from '../../platform/http/problem.ts';
import { parseRequest, ProblemError } from '../../platform/http/validation.ts';
import { requestContext } from '../audit/context.ts';
import { limitMailTo } from '../rate-limit/http.ts';
import type { RateLimiter } from '../rate-limit/limiter.ts';
import { emailRequest, registerRequest, tokenRequest } from './schemas.ts';
import type { AccountsService } from './service.ts';

/** Public auth endpoints of `openapi/openapi.yaml` (tag `auth`), mounted under `/v1`. */

export interface AccountsRoutesOptions {
  readonly accounts: AccountsService;
  readonly limiter: RateLimiter;
}

/** Identical for every outcome, so the answer never reveals whether an address is registered (R-AUTH-07). */
export const ACCEPTED = Object.freeze({ message: 'If the request can be fulfilled, an email has been sent.' });

/** `security: []` in the contract. */
const PUBLIC = { config: { public: true } };

export const accountsRoutes: FastifyPluginCallback<AccountsRoutesOptions> = (app, { accounts, limiter }, done) => {
  app.post('/auth/register', PUBLIC, async (request, reply) => {
    const body = parseRequest(registerRequest, request.body);
    // The mail limit applies once the password passed the breach check: a weak password costs no email allowance.
    const result = await accounts.register(body, () => limitMailTo(limiter, request, body.email));
    if (result === 'weak_password') throw new ProblemError(Problems.weakPassword);
    return reply.code(202).send(ACCEPTED);
  });

  app.post('/auth/verify-email', PUBLIC, async (request, reply) => {
    const { token } = parseRequest(tokenRequest, request.body);
    if ((await accounts.verifyEmail(token, requestContext(request))) === 'invalid_token') {
      throw new ProblemError(Problems.invalidToken);
    }
    return reply.code(204).send();
  });

  app.post('/auth/resend-verification', PUBLIC, async (request, reply) => {
    const { email } = parseRequest(emailRequest, request.body);
    await limitMailTo(limiter, request, email);
    await accounts.resendVerification(email);
    return reply.code(202).send(ACCEPTED);
  });

  done();
};
