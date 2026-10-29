import type { FastifyPluginCallback } from 'fastify';
import { Problems } from '../../platform/http/problem.ts';
import { parseRequest, ProblemError } from '../../platform/http/validation.ts';
import { requestContext } from '../audit/context.ts';
import { emailRequest, registerRequest, tokenRequest } from './schemas.ts';
import type { AccountsService } from './service.ts';

/** Public auth endpoints of `openapi/openapi.yaml` (tag `auth`), mounted under `/v1`. */

export interface AccountsRoutesOptions {
  readonly accounts: AccountsService;
}

/** Identical for every outcome, so the answer never reveals whether an address is registered (R-AUTH-07). */
export const ACCEPTED = Object.freeze({ message: 'If the request can be fulfilled, an email has been sent.' });

export const accountsRoutes: FastifyPluginCallback<AccountsRoutesOptions> = (app, { accounts }, done) => {
  app.post('/auth/register', async (request, reply) => {
    const body = parseRequest(registerRequest, request.body);
    if ((await accounts.register(body)) === 'weak_password') throw new ProblemError(Problems.weakPassword);
    return reply.code(202).send(ACCEPTED);
  });

  app.post('/auth/verify-email', async (request, reply) => {
    const { token } = parseRequest(tokenRequest, request.body);
    if ((await accounts.verifyEmail(token, requestContext(request))) === 'invalid_token') {
      throw new ProblemError(Problems.invalidToken);
    }
    return reply.code(204).send();
  });

  app.post('/auth/resend-verification', async (request, reply) => {
    const { email } = parseRequest(emailRequest, request.body);
    await accounts.resendVerification(email);
    return reply.code(202).send(ACCEPTED);
  });

  done();
};
