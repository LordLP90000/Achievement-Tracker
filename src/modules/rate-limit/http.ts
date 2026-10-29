import type { FastifyInstance, FastifyRequest } from 'fastify';
import { normalizeEmail } from '../../platform/crypto/blind-index.ts';
import { Problems } from '../../platform/http/problem.ts';
import { ProblemError } from '../../platform/http/validation.ts';
import { ipSubject } from './keys.ts';
import { LIMITS, type RateLimiter } from './limiter.ts';

/** Answers 429 with `Retry-After` when a limit says wait; logs the scope only, never the subject. */
export async function enforce(wait: Promise<number>, request: FastifyRequest, scope: string): Promise<void> {
  const seconds = await wait;
  if (seconds === 0) return;
  request.log.warn({ scope }, 'rate limited');
  throw new ProblemError({ ...Problems.rateLimited, retryAfterSeconds: seconds });
}

/** Requests that may email `email`: limited per normalised address, registered or not (no enumeration). */
export function limitMailTo(limiter: RateLimiter, request: FastifyRequest, email: string): Promise<void> {
  const limit = LIMITS.emailMail;
  return enforce(limiter.take(limit, normalizeEmail(email)), request, limit.scope);
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Authenticated routes that document `429` in the contract; only these are limited per user. */
    readonly userRateLimit?: boolean;
  }
}

/**
 * Register after the auth guard: public routes are limited per client network; authenticated routes that document
 * `429` (`config.userRateLimit`) per user — the contract allows no 429 elsewhere. Runs before the body is parsed;
 * limits that need the body (an email address) are taken by the handlers.
 */
export function registerRequestLimits(app: FastifyInstance, limiter: RateLimiter): void {
  app.addHook('onRequest', async (request) => {
    const { principal } = request;
    if (principal === null) {
      await enforce(limiter.take(LIMITS.ipAuth, ipSubject(request.ip)), request, LIMITS.ipAuth.scope);
    } else if (request.routeOptions.config.userRateLimit === true) {
      await enforce(limiter.take(LIMITS.user, principal.userId), request, LIMITS.user.scope);
    }
  });
}
