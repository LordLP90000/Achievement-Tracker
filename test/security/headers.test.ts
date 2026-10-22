import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/app.ts';

const EXPECTED_HEADERS = {
  'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'x-frame-options': 'DENY',
  'cache-control': 'no-store',
  pragma: 'no-cache',
};

const json = { 'content-type': 'application/json' };

const responseClasses: [string, InjectOptions, number][] = [
  ['200 from a route', { method: 'GET', url: '/__test/ok' }, 200],
  ['404 for an unknown route', { method: 'GET', url: '/nope' }, 404],
  ['400 for malformed JSON', { method: 'POST', url: '/__test/echo', headers: json, payload: '{"a":' }, 400],
  [
    '413 for an oversized body',
    { method: 'POST', url: '/__test/echo', headers: json, payload: JSON.stringify({ a: 'x'.repeat(64 * 1024) }) },
    413,
  ],
  [
    '415 for a non-JSON body',
    { method: 'POST', url: '/__test/echo', headers: { 'content-type': 'text/plain' }, payload: 'hello' },
    415,
  ],
  ['500 for an unexpected error', { method: 'GET', url: '/__test/boom' }, 500],
];

describe('security headers [R-TLS-01, R-TLS-02, I-07]', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each(responseClasses)('are set on a %s', async (_label, request, status) => {
    const response = await app.inject(request);

    expect(response.statusCode).toBe(status);
    expect(response.headers).toMatchObject(EXPECTED_HEADERS);
    expect(response.headers['permissions-policy']).toContain('camera=()');
  });

  it('never include CORS headers, even for cross-origin and preflight requests [R-TLS-03]', async () => {
    const origin = { origin: 'https://evil.example' };
    const simple = await app.inject({ method: 'GET', url: '/__test/ok', headers: origin });
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/__test/ok',
      headers: { ...origin, 'access-control-request-method': 'POST' },
    });

    for (const response of [simple, preflight]) {
      expect(Object.keys(response.headers).filter((name) => name.startsWith('access-control-'))).toEqual([]);
    }
    expect(preflight.statusCode).toBe(404);
  });

  it('do not disclose the server software', async () => {
    const response = await app.inject({ method: 'GET', url: '/__test/ok' });

    expect(response.headers.server).toBeUndefined();
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});
