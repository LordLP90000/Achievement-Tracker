import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/app.ts';
import { createLogger } from '../../src/platform/logging/logger.ts';
import type { LogCapture } from './log-capture.ts';

export const UUID_V4 = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

/** Message of the error thrown by the test-only failure route; it must never reach a client. */
export const LEAKY_ERROR_MESSAGE = 'SELECT secret FROM users WHERE id = 1 at /srv/questline/src/secret.ts:42';

export interface TestAppOptions {
  readonly trustProxyHops?: number;
  readonly logCapture?: LogCapture;
}

/** The production app plus test-only routes (`/__test/*`) that exercise body parsing and failures. */
export async function buildTestApp(options: TestAppOptions = {}): Promise<FastifyInstance> {
  const logger = options.logCapture
    ? createLogger({ service: 'questline-api', level: 'info' }, options.logCapture.stream)
    : createLogger({ service: 'questline-api', level: 'silent' });
  const app = buildApp({ http: { trustProxyHops: options.trustProxyHops ?? 0 }, logger });
  app.get('/__test/ok', () => ({ ok: true }));
  app.get('/__test/ip', (request) => ({ ip: request.ip }));
  app.get('/__test/items/:id', () => ({ ok: true }));
  app.post('/__test/echo', (request) => ({ received: request.body }));
  app.get('/__test/boom', () => {
    throw new Error(LEAKY_ERROR_MESSAGE);
  });
  await app.ready();
  return app;
}
