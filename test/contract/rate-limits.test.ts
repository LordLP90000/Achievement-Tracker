import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { LIMITS } from '../../src/modules/rate-limit/limiter.ts';
import { createLogger } from '../../src/platform/logging/logger.ts';
import { specOperations, type SpecOperation } from '../helpers/openapi.ts';
import { ALLOW_ALL, UNAVAILABLE_SERVICES } from '../helpers/stub-services.ts';
import { NOT_YET_IMPLEMENTED } from './not-yet-implemented.ts';

const v1Operations = specOperations.filter((operation) => operation.path.startsWith('/v1/'));
const implemented = v1Operations.filter((operation) => !NOT_YET_IMPLEMENTED.has(operation.operationId));

describe('rate limits versus the contract [R-AUTH-08, Q-30, ADR-0010]', () => {
  it('documents 429 on every /v1 operation, public or authenticated, implemented or not', () => {
    const undocumented = v1Operations.filter((operation) => !('429' in operation.responses));

    expect(undocumented.map((operation) => operation.operationId)).toEqual([]);
  });

  describe('every implemented /v1 route takes a bucket before its handler runs', () => {
    const userId = randomUUID();
    const taken: string[] = [];
    let app: FastifyInstance;

    beforeAll(async () => {
      app = buildApp({
        http: { trustProxyHops: 0 },
        logger: createLogger({ service: 'questline-api', level: 'silent' }),
        readiness: () => Promise.resolve(true),
        services: {
          ...UNAVAILABLE_SERVICES,
          // Records which bucket each request takes first; never refuses, so the request reaches its handler.
          rateLimiter: {
            ...ALLOW_ALL,
            take: (limit, subject) => {
              taken.push(`${limit.scope}:${subject === userId ? 'the user' : 'another subject'}`);
              return Promise.resolve(0);
            },
          },
          // Any bearer token authenticates as the same user; every other service call fails (500, not asserted).
          sessions: {
            ...UNAVAILABLE_SERVICES.sessions,
            authenticate: () => Promise.resolve({ userId, sessionId: randomUUID(), lastReauthAt: new Date(0) }),
          },
        },
      });
      await app.ready();
    });

    afterAll(async () => {
      await app.close();
    });

    it.each(implemented.map((operation) => [operation.operationId, operation] as const))(
      '%s: per user when authenticated, per client network when public',
      async (_operationId, operation: SpecOperation) => {
        taken.length = 0;
        await app.inject({
          method: operation.method as 'GET',
          url: operation.path.replace(/\{[^}]+\}/g, randomUUID()),
          headers: {
            authorization: `Bearer ql_at_${'A'.repeat(43)}`,
            ...(operation.hasRequestBody ? { 'content-type': 'application/json' } : {}),
          },
          ...(operation.hasRequestBody ? { payload: '{}' } : {}),
        });

        expect(taken[0]).toBe(
          operation.requiresAuth ? `${LIMITS.user.scope}:the user` : `${LIMITS.ipAuth.scope}:another subject`,
        );
      },
    );
  });
});
