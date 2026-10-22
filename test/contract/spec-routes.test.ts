import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.ts';
import { createLogger } from '../../src/platform/logging/logger.ts';
import { specOperations } from '../helpers/openapi.ts';
import { NOT_YET_IMPLEMENTED } from './not-yet-implemented.ts';

describe('routes versus the OpenAPI contract [ADR-0010]', () => {
  it('registers exactly the documented operations that are implemented — no undocumented route', async () => {
    const app = buildApp({
      http: { trustProxyHops: 0 },
      logger: createLogger({ service: 'questline-api', level: 'silent' }),
      readiness: () => Promise.resolve(true),
    });
    const registered: string[] = [];
    app.addHook('onRoute', (route) => {
      for (const method of [route.method].flat()) registered.push(`${method} ${route.url}`);
    });
    await app.ready();
    await app.close();

    const expected = specOperations
      .filter((operation) => !NOT_YET_IMPLEMENTED.has(operation.operationId))
      .map((operation) => `${operation.method} ${operation.fastifyPath}`);
    expect(registered.sort()).toEqual(expected.sort());
  });

  it('lists only operations that exist in the contract as not yet implemented', () => {
    const known = new Set(specOperations.map((operation) => operation.operationId));

    expect([...NOT_YET_IMPLEMENTED].filter((operationId) => !known.has(operationId))).toEqual([]);
  });
});
