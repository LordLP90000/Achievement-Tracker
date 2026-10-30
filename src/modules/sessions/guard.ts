import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Problems } from '../../platform/http/problem.ts';
import { ProblemError } from '../../platform/http/validation.ts';

/** The authenticated device session of a request (architecture §3, step 5). */
export interface Principal {
  readonly userId: string;
  readonly sessionId: string;
  readonly lastReauthAt: Date;
}

export interface Authenticator {
  authenticate(accessToken: string): Promise<Principal | undefined>;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Only operations with `security: []` in the contract; every other route requires an access token. */
    readonly public?: boolean;
  }

  interface FastifyRequest {
    principal: Principal | null;
  }
}

/** RFC 9110: the scheme is case-insensitive; exactly one space before the token. */
const BEARER = /^bearer (\S+)$/i;

/** The token of an `Authorization: Bearer <token>` header; undefined for any other header or none. */
export function bearerTokenOf(header: string | undefined): string | undefined {
  return BEARER.exec(header ?? '')?.[1];
}

/**
 * Deny by default (R-AUTHZ-01): every route registered in `app` after this call needs a valid access token unless
 * its config says `public: true`. Runs before the body is parsed, so unauthenticated requests cost no parsing.
 */
export function registerAuthGuard(app: FastifyInstance, authenticator: Authenticator): void {
  app.decorateRequest('principal', null);
  app.addHook('onRequest', async (request) => {
    if (request.routeOptions.config.public === true) return;
    const token = bearerTokenOf(request.headers.authorization);
    const principal = token === undefined ? undefined : await authenticator.authenticate(token);
    request.principal = principal ?? deny();
  });
}

function deny(): never {
  throw new ProblemError(Problems.unauthorized);
}

/** The principal of a guarded route; calling it on a public route is a programming error. */
export function principalOf(request: FastifyRequest): Principal {
  if (request.principal === null) throw new Error('route is not behind the auth guard');
  return request.principal;
}

/** R-AUTH-06 / Q-07: sensitive operations need the password entered (login or re-auth) within this window. */
export const REAUTH_WINDOW_MS = 10 * 60 * 1000;

/** True when the session entered the password less than 10 minutes before `now` (else: 403 for sensitive work). */
export function hasRecentReauth(principal: Principal, now: Date): boolean {
  return now.getTime() - principal.lastReauthAt.getTime() < REAUTH_WINDOW_MS;
}
