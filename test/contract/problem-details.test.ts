import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, LEAKY_ERROR_MESSAGE, UUID_V4 } from '../helpers/app.ts';

const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';
const json = { 'content-type': 'application/json' };
const invalidBodyErrors = [{ pointer: '', message: 'The request body is not valid JSON.' }];

describe('problem details [ADR-0007, R-OUT-01, I-03]', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers unknown routes with a 404 problem whose instance omits the query string', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/does-not-exist?token=QuerySecret123' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toBe(PROBLEM_CONTENT_TYPE);
    expect(response.json()).toEqual({
      type: 'urn:questline:problem:not-found',
      title: 'Not Found',
      status: 404,
      instance: '/v1/does-not-exist',
      request_id: expect.stringMatching(UUID_V4) as unknown,
    });
    expect(response.body).not.toContain('QuerySecret123');
  });

  it('truncates the instance to 300 characters', async () => {
    const response = await app.inject({ method: 'GET', url: `/${'a'.repeat(500)}` });

    expect(response.json<{ instance: string }>().instance).toHaveLength(300);
  });

  it('hides every internal detail of unexpected errors [I-03]', async () => {
    const response = await app.inject({ method: 'GET', url: '/__test/boom' });

    expect(response.statusCode).toBe(500);
    expect(response.headers['content-type']).toBe(PROBLEM_CONTENT_TYPE);
    expect(response.json()).toEqual({
      type: 'urn:questline:problem:internal',
      title: 'Internal Server Error',
      status: 500,
      instance: '/__test/boom',
      request_id: expect.stringMatching(UUID_V4) as unknown,
    });
    for (const fragment of [LEAKY_ERROR_MESSAGE, 'SELECT', '/srv/', 'secret.ts', 'stack']) {
      expect(response.body).not.toContain(fragment);
    }
  });

  it('rejects bodies over 64 KiB with a 413 problem [R-IN-01, D-02]', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/__test/echo',
      headers: json,
      payload: JSON.stringify({ a: 'x'.repeat(64 * 1024) }),
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({ type: 'urn:questline:problem:payload-too-large', status: 413 });
  });

  it('accepts a body just under the limit', async () => {
    const payload = JSON.stringify({ a: 'x'.repeat(64 * 1024 - 100) });
    const response = await app.inject({ method: 'POST', url: '/__test/echo', headers: json, payload });

    expect(response.statusCode).toBe(200);
  });

  it.each(['text/plain', 'application/xml', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x'])(
    'accepts JSON only and rejects %s with a 415 problem [D-02]',
    async (contentType) => {
      const response = await app.inject({
        method: 'POST',
        url: '/__test/echo',
        headers: { 'content-type': contentType },
        payload: 'a=1',
      });

      expect(response.statusCode).toBe(415);
      expect(response.json()).toMatchObject({ type: 'urn:questline:problem:unsupported-media-type', status: 415 });
    },
  );

  it.each([
    ['malformed JSON', '{"password":"Hunter2Secret",'],
    ['an empty JSON body', ''],
    ['a __proto__ key [T-04]', '{"__proto__":{"isAdmin":true},"note":"Hunter2Secret"}'],
    ['a constructor.prototype key [T-04]', '{"constructor":{"prototype":{"isAdmin":true}},"note":"Hunter2Secret"}'],
  ])('rejects %s with a 400 validation problem that echoes nothing [I-22]', async (_label, payload) => {
    const response = await app.inject({ method: 'POST', url: '/__test/echo', headers: json, payload });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      type: 'urn:questline:problem:validation',
      title: 'Request validation failed',
      status: 400,
      instance: '/__test/echo',
      request_id: expect.stringMatching(UUID_V4) as unknown,
      errors: invalidBodyErrors,
    });
    expect(response.body).not.toContain('Hunter2Secret');
  });

  it('still parses valid JSON', async () => {
    const response = await app.inject({ method: 'POST', url: '/__test/echo', headers: json, payload: '{"a":1}' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ received: { a: 1 } });
  });
});
