import { describe, expect, it } from 'vitest';
import { BODY_LIMIT_BYTES } from '../../src/app.ts';
import { buildTestApp } from '../helpers/app.ts';

const json = { 'content-type': 'application/json' };

/** Hostile JSON within the 64 KiB body limit: deep nesting must cost a 400, never the process (D-02, R-IN-01). */
describe('request body limits [D-02]', () => {
  const login = async (payload: string) => {
    const app = await buildTestApp();
    try {
      const response = await app.inject({ method: 'POST', url: '/v1/auth/login', headers: json, payload });
      const health = await app.inject({ method: 'GET', url: '/health/live' });
      return { status: response.statusCode, body: response.body, alive: health.statusCode };
    } finally {
      await app.close();
    }
  };

  it.each([
    ['arrays', (depth: number) => `${'['.repeat(depth)}${']'.repeat(depth)}`, 30_000],
    ['objects', (depth: number) => `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`, 10_000],
  ])('answers %s nested to the size limit with a 400 problem and keeps serving', async (_kind, nest, depth) => {
    const payload = `{"email":${nest(depth)},"password":"correct horse battery","client":"ios"}`;
    expect(payload.length).toBeLessThan(BODY_LIMIT_BYTES);

    const result = await login(payload);

    expect(result.status).toBe(400);
    expect(result.body).toContain('urn:questline:problem:validation');
    expect(result.alive).toBe(200);
  });
});
