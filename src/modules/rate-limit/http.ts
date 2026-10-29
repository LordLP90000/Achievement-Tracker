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

/**
 * Register after the auth guard: every `/v1` route takes a bucket before its body is parsed — public routes per
 * client network, every authenticated route per user (the contract documents `429` on every operation, Q-30), so
 * a new route cannot be left unlimited. Limits that need the body (an email address) are taken by the handlers.
 */
export function registerRequestLimits(app: FastifyInstance, limiter: RateLimiter): void {
  app.addHook('onRequest', async (request) => {
    const { principal } = request;
    if (principal === null) {
      await enforce(limiter.take(LIMITS.ipAuth, ipSubject(request.ip)), request, LIMITS.ipAuth.scope);
    } else {
      await enforce(limiter.take(LIMITS.user, principal.userId), request, LIMITS.user.scope);
    }
  });
}
