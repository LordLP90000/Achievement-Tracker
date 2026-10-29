import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildApp } from '../../src/app.ts';
import type { ReadinessProbe } from '../../src/modules/health/routes.ts';
import { parseRequest } from '../../src/platform/http/validation.ts';
import { createLogger } from '../../src/platform/logging/logger.ts';
import type { LogCapture } from './log-capture.ts';
import { UNAVAILABLE_SERVICES } from './stub-services.ts';

export const UUID_V4 = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

/** Message of the error thrown by the test-only failure route; it must never reach a client. */
export const LEAKY_ERROR_MESSAGE = 'SELECT secret FROM users WHERE id = 1 at /srv/questline/src/secret.ts:42';

export interface TestAppOptions {
  readonly trustProxyHops?: number;
  readonly logCapture?: LogCapture;
  readonly readiness?: ReadinessProbe;
  readonly readinessTimeoutMs?: number;
}

/** The production app plus test-only routes (`/__test/*`) that exercise body parsing and failures. */
export async function buildTestApp(options: TestAppOptions = {}): Promise<FastifyInstance> {
  const logger = options.logCapture
    ? createLogger({ service: 'questline-api', level: 'info' }, options.logCapture.stream)
    : createLogger({ service: 'questline-api', level: 'silent' });
  const app = buildApp({
    http: { trustProxyHops: options.trustProxyHops ?? 0 },
    logger,
    readiness: options.readiness ?? (() => Promise.resolve(true)),
    ...(options.readinessTimeoutMs === undefined ? {} : { readinessTimeoutMs: options.readinessTimeoutMs }),
    services: UNAVAILABLE_SERVICES,
  });
  app.get('/__test/ok', () => ({ ok: true }));
  app.get('/__test/ip', (request) => ({ ip: request.ip }));
  app.get('/__test/items/:id', () => ({ ok: true }));
  app.post('/__test/echo', (request) => ({ received: request.body }));
  app.post('/__test/validate', (request) => parseRequest(z.strictObject({ email: z.email() }), request.body));
  app.get('/__test/boom', () => {
    throw new Error(LEAKY_ERROR_MESSAGE);
  });
  await app.ready();
  return app;
}
