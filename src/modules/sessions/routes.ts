import type { FastifyPluginCallback } from 'fastify';
import { Problems } from '../../platform/http/problem.ts';
import { isUuidV4, parseRequest, ProblemError } from '../../platform/http/validation.ts';
import { normalizeEmail } from '../../platform/crypto/blind-index.ts';
import { requestContext } from '../audit/context.ts';
import { enforce } from '../rate-limit/http.ts';
import { BACKOFFS, type RateLimiter } from '../rate-limit/limiter.ts';
import { principalOf } from './guard.ts';
import { loginRequest, reauthRequest, refreshRequest } from './schemas.ts';
import type { IssuedTokens, SessionsService } from './service.ts';

/** Session endpoints of `openapi/openapi.yaml` (tag `auth`), mounted under `/v1` behind the auth guard. */

export interface SessionsRoutesOptions {
  readonly sessions: SessionsService;
  readonly limiter: RateLimiter;
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

export const sessionsRoutes: FastifyPluginCallback<SessionsRoutesOptions> = (app, { sessions, limiter }, done) => {
  app.post('/auth/login', PUBLIC, async (request, reply) => {
    const body = parseRequest(loginRequest, request.body);
    // Per submitted address, registered or not, so the backoff itself reveals nothing (R-AUTH-07, D-04).
    const subject = normalizeEmail(body.email);
    const backoff = BACKOFFS.emailLogin;
    await enforce(limiter.blocked(backoff, subject), request, backoff.scope);
    const result = await sessions.login(body, requestContext(request));
    await limiter.record(backoff, subject, result.outcome !== 'invalid_credentials');
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

  app.post('/auth/reauth', async (request, reply) => {
    const { password } = parseRequest(reauthRequest, request.body);
    const principal = principalOf(request);
    const backoff = BACKOFFS.userPassword;
    await enforce(limiter.blocked(backoff, principal.userId), request, backoff.scope);
    const valid = await sessions.reauthenticate(principal, password, requestContext(request));
    await limiter.record(backoff, principal.userId, valid);
    if (!valid) {
      throw new ProblemError(Problems.invalidCredentials);
    }
    return reply.code(204).send();
  });

  app.get('/me/sessions', async (request) => {
    const items = await sessions.listSessions(principalOf(request));
    return {
      items: items.map((session) => ({
        id: session.id,
        client: session.client,
        device_label: session.deviceLabel,
        created_at: session.createdAt.toISOString(),
        last_used_at: session.lastUsedAt.toISOString(),
        current: session.current,
      })),
    };
  });

  app.delete<{ Params: { sessionId: string } }>('/me/sessions/:sessionId', async (request, reply) => {
    const { sessionId } = request.params;
    // The contract documents no 400 here: an ID that cannot exist is simply not found.
    const revoked =
      isUuidV4(sessionId) && (await sessions.revokeSession(principalOf(request), sessionId, requestContext(request)));
    if (!revoked) throw new ProblemError(Problems.notFound);
    return reply.code(204).send();
  });

  done();
};
