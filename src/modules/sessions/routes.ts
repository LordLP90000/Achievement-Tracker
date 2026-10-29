import type { FastifyPluginCallback } from 'fastify';
import { Problems } from '../../platform/http/problem.ts';
import { parseRequest, ProblemError } from '../../platform/http/validation.ts';
import { requestContext } from '../audit/context.ts';
import { principalOf } from './guard.ts';
import { loginRequest, refreshRequest } from './schemas.ts';
import type { IssuedTokens, SessionsService } from './service.ts';

/** Session endpoints of `openapi/openapi.yaml` (tag `auth`), mounted under `/v1` behind the auth guard. */

export interface SessionsRoutesOptions {
  readonly sessions: SessionsService;
}

/** `security: []` in the contract. */
const PUBLIC = { config: { public: true } };

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
  app.post('/auth/login', PUBLIC, async (request, reply) => {
    const result = await sessions.login(parseRequest(loginRequest, request.body), requestContext(request));
    if (result.outcome === 'invalid_credentials') throw new ProblemError(Problems.invalidCredentials);
    if (result.outcome === 'email_not_verified') throw new ProblemError(Problems.emailNotVerified);
    return reply.code(200).send(tokenPair(result.tokens));
  });

  app.post('/auth/refresh', PUBLIC, async (request, reply) => {
    const { refresh_token: refreshToken } = parseRequest(refreshRequest, request.body);
    const tokens = await sessions.refresh(refreshToken, requestContext(request));
    if (tokens === undefined) throw new ProblemError(Problems.invalidToken);
    return reply.code(200).send(tokenPair(tokens));
  });

  app.post('/auth/logout', async (request, reply) => {
    await sessions.logout(principalOf(request), requestContext(request));
    return reply.code(204).send();
  });

  app.post('/auth/logout-all', async (request, reply) => {
    await sessions.logoutAll(principalOf(request), requestContext(request));
    return reply.code(204).send();
  });

  done();
};
