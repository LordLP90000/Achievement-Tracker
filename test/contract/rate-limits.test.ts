import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { createLogger } from '../../src/platform/logging/logger.ts';
import { specOperations } from '../helpers/openapi.ts';
import { UNAVAILABLE_SERVICES } from '../helpers/stub-services.ts';
import { NOT_YET_IMPLEMENTED } from './not-yet-implemented.ts';

describe('rate-limited routes versus the contract [R-AUTH-08, ADR-0010]', () => {
  it('limits exactly the implemented /v1 operations that document 429, and no other', async () => {
    const app = buildApp({
      http: { trustProxyHops: 0 },
      logger: createLogger({ service: 'questline-api', level: 'silent' }),
      readiness: () => Promise.resolve(true),
      services: UNAVAILABLE_SERVICES,
    });
    const limited: string[] = [];
    app.addHook('onRoute', (route) => {
      const { config } = route;
      if (route.url.startsWith('/v1/') && (config?.public === true || config?.userRateLimit === true)) {
        for (const method of [route.method].flat()) limited.push(`${method} ${route.url}`);
      }
    });
    await app.ready();
    await app.close();

    const documented = specOperations
      .filter((operation) => !NOT_YET_IMPLEMENTED.has(operation.operationId))
      .filter((operation) => operation.path.startsWith('/v1/') && '429' in operation.responses)
      .map((operation) => `${operation.method} ${operation.fastifyPath}`);
    expect(limited.sort()).toEqual(documented.sort());
  });
});
