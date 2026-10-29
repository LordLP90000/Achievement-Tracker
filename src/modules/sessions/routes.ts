import type { FastifyPluginCallback } from 'fastify';
import { Problems } from '../../platform/http/problem.ts';
import { parseRequest, ProblemError } from '../../platform/http/validation.ts';
import { requestContext } from '../audit/context.ts';
import { loginRequest } from './schemas.ts';
import type { IssuedTokens, SessionsService } from './service.ts';

/** Session endpoints of `openapi/openapi.yaml` (tag `auth`), mounted under `/v1`. */

export interface SessionsRoutesOptions {
  readonly sessions: SessionsService;
}

/** `TokenPair` in the contract; lifetimes in whole seconds from the moment of issue. */
export function tokenPair(tokens: IssuedTokens) {
  const secondsUntil = (instant: Date) => Math.floor((instant.getTime() - tokens.issuedAt.getTime()) / 1000);
  return {
    token_type: 'Bearer',
    access_token: tokens.accessToken,
    access_expires_in: secondsUntil(tokens.accessExpiresAt),
    refresh_token: tokens.refreshToken,
    refresh_expires_in: secondsUntil(tokens.refreshExpiresAt),
    session_id: tokens.sessionId,
  };
}

export const sessionsRoutes: FastifyPluginCallback<SessionsRoutesOptions> = (app, { sessions }, done) => {
  app.post('/auth/login', async (request, reply) => {
    const result = await sessions.login(parseRequest(loginRequest, request.body), requestContext(request));
    if (result.outcome === 'invalid_credentials') throw new ProblemError(Problems.invalidCredentials);
    if (result.outcome === 'email_not_verified') throw new ProblemError(Problems.emailNotVerified);
    return reply.code(200).send(tokenPair(result.tokens));
  });

  done();
};
