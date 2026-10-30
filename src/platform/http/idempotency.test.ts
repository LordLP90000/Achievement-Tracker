import fc from 'fast-check';
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { registerErrorHandling } from './errors.ts';
import { canonicalJson, idempotentRequest, sendIdempotent, type IdempotentOutcome } from './idempotency.ts';
import { ProblemError } from './validation.ts';

const KEY = randomUUID();
const PARAMS = { achievementId: '0b4c1f7e-2f57-4e7a-9c1d-3a5b6c7d8e9f' };
const BODY = { title: 'Run', size: 'M', notes: null, habit: { period: 'week', times_per_period: 3 } };

const digest = (params: unknown, body: unknown) => idempotentRequest('createQuest', KEY, params, body).requestHash;

/** The same JSON value with every object's properties inserted in reverse order. */
function reversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedKeys);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, inner]) => [key, reversedKeys(inner)]),
  );
}

async function send(outcome: IdempotentOutcome) {
  const app = Fastify();
  registerErrorHandling(app);
  app.post('/v1/achievements', (_request, reply) => sendIdempotent(reply, outcome));
  try {
    return await app.inject({ method: 'POST', url: '/v1/achievements' });
  } finally {
    await app.close();
  }
}

const STORED = {
  status: 201,
  headers: { etag: '"1"', location: `/v1/achievements/${PARAMS.achievementId}` },
  body: { id: PARAMS.achievementId, title: 'Run', version: 1 },
};

describe('idempotency keys [ADR-0008, Q-39]', () => {
  it('names the route, the key and a SHA-256 digest of the request', () => {
    const request = idempotentRequest('createQuest', KEY, PARAMS, BODY);

    expect(request.route).toBe('createQuest');
    expect(request.key).toBe(KEY);
    expect(request.requestHash).toHaveLength(32);
  });

  it('digests a repeated request equally, whatever the order of its properties', () => {
    expect(digest({ ...PARAMS }, reversedKeys(BODY))).toEqual(digest(PARAMS, BODY));
  });

  it.each([
    ['another value', PARAMS, { ...BODY, title: 'Walk' }],
    ['another type', PARAMS, { ...BODY, notes: 'null' }],
    ['a missing field instead of null', PARAMS, { title: 'Run', size: 'M', habit: BODY.habit }],
    ['another nested value', PARAMS, { ...BODY, habit: { period: 'week', times_per_period: 4 } }],
    ['another parent in the path', { achievementId: '1b4c1f7e-2f57-4e7a-9c1d-3a5b6c7d8e9f' }, BODY],
  ])('digests a request with %s differently', (_case, params, body) => {
    expect(digest(params, body)).not.toEqual(digest(PARAMS, BODY));
  });

  it('writes JSON canonically: sorted properties at every depth, arrays in their order', () => {
    expect(canonicalJson({ b: [{ d: 1, c: 2 }, 'x'], a: null })).toBe('{"a":null,"b":[{"c":2,"d":1},"x"]}');
    expect(canonicalJson({ skipped: undefined, kept: 1 })).toBe('{"kept":1}');
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const canonical = canonicalJson(value);
        expect(canonicalJson(reversedKeys(value))).toBe(canonical);
        expect(canonicalJson(JSON.parse(canonical))).toBe(canonical);
      }),
    );
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['not a UUID', 'retry-1'],
    ['upper case', KEY.toUpperCase()],
    ['a version 1 UUID', '6f1c2a3b-4d5e-1f60-8a7b-9c0d1e2f3a4b'],
    ['in braces', `{${KEY}}`],
    ['sent twice', `${KEY}, ${KEY}`],
    ['a list', [KEY, KEY]],
  ])('refuses an Idempotency-Key that is %s with a 400 that echoes nothing', (_case, header) => {
    let problem: unknown;
    try {
      idempotentRequest('createAchievement', header, {}, BODY);
    } catch (error) {
      problem = error instanceof ProblemError ? error.problem : error;
    }

    expect(problem).toMatchObject({ status: 400, slug: 'validation', errors: [{ pointer: '' }] });
    expect(JSON.stringify(problem)).not.toContain('retry-1');
  });

  it('sends a first response as it was produced', async () => {
    const response = await send({ outcome: 'executed', response: STORED });

    expect(response.statusCode).toBe(201);
    expect(response.headers).toMatchObject(STORED.headers);
    expect(response.headers['idempotency-replayed']).toBeUndefined();
    expect(response.json()).toEqual(STORED.body);
  });

  it('sends a replay like the first response, marked with Idempotency-Replayed: true', async () => {
    const response = await send({ outcome: 'replayed', response: STORED });

    expect(response.statusCode).toBe(201);
    expect(response.headers).toMatchObject({ ...STORED.headers, 'idempotency-replayed': 'true' });
    expect(response.json()).toEqual(STORED.body);
  });

  it('answers a key reused for another request with 422 idempotency-key-reused [T-13]', async () => {
    const response = await send({ outcome: 'key_reused' });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      type: 'urn:questline:problem:idempotency-key-reused',
      status: 422,
      errors: [{ pointer: '' }],
    });
  });
});
