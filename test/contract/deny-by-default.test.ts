import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { createLogger } from '../../src/platform/logging/logger.ts';
import { contractInject } from '../helpers/contract.ts';
import { specOperations, type SpecOperation } from '../helpers/openapi.ts';
import { UNAVAILABLE_SERVICES } from '../helpers/stub-services.ts';
import { NOT_YET_IMPLEMENTED } from './not-yet-implemented.ts';

const implemented = specOperations.filter((operation) => !NOT_YET_IMPLEMENTED.has(operation.operationId));
const named = (operations: readonly SpecOperation[]) =>
  operations.map((operation) => [operation.operationId, operation]);

describe('deny by default [R-AUTHZ-01, ADR-0010]', () => {
  let app: FastifyInstance;
  const publicRoutes = new Set<string>();

  beforeAll(async () => {
    app = buildApp({
      http: { trustProxyHops: 0 },
      logger: createLogger({ service: 'questline-api', level: 'silent' }),
      readiness: () => Promise.resolve(true),
      services: UNAVAILABLE_SERVICES,
    });
    app.addHook('onRoute', (route) => {
      if (route.config?.public === true)
        for (const method of [route.method].flat()) publicRoutes.add(`${method} ${route.url}`);
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const call = (operation: SpecOperation, headers: Record<string, string> = {}) =>
    contractInject(app, {
      method: operation.method as 'GET',
      url: operation.path.replace(/\{[^}]+\}/g, randomUUID()),
      headers: operation.hasRequestBody ? { ...headers, 'content-type': 'application/json' } : headers,
      ...(operation.hasRequestBody ? { payload: '{}' } : {}),
    });

  it('marks exactly the operations with `security: []` as public, so every new route is protected unless the contract says otherwise', () => {
    const expected = implemented
      .filter((operation) => !operation.requiresAuth && operation.path.startsWith('/v1/'))
      .map((operation) => `${operation.method} ${operation.fastifyPath}`);

    expect([...publicRoutes].sort()).toEqual(expected.sort());
    expect(implemented.some((operation) => operation.requiresAuth)).toBe(true);
  });

  it.each(named(implemented.filter((operation) => operation.requiresAuth)))(
    '%s answers 401 with WWW-Authenticate when no or no valid access token is sent',
    async (_operationId, operation) => {
      for (const headers of [
        {},
        { authorization: 'Basic dXNlcjpwYXNz' },
        { authorization: `Bearer ql_at_${'A'.repeat(43)}` },
      ]) {
        const response = await call(operation as SpecOperation, headers);

        expect(response.statusCode).toBe(401);
        expect(response.headers['www-authenticate']).toBe('Bearer');
        expect(response.json()).toMatchObject({ type: 'urn:questline:problem:unauthorized', status: 401 });
      }
    },
  );

  it.each(named(implemented.filter((operation) => !operation.requiresAuth)))(
    '%s needs no token',
    async (_operationId, operation) => {
      expect((await call(operation as SpecOperation)).statusCode).not.toBe(401);
    },
  );
});
