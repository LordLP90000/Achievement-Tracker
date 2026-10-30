import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BODY_LIMIT_BYTES } from '../../src/app.ts';
import { NOT_YET_IMPLEMENTED } from '../contract/not-yet-implemented.ts';
import { startAccountsApp, type AccountsApp } from '../helpers/accounts-app.ts';
import { buildTestApp } from '../helpers/app.ts';
import { bearer, goalUser, type GoalUser } from '../helpers/goals.ts';
import { specOperations } from '../helpers/openapi.ts';

const json = { 'content-type': 'application/json' };
const IF_MATCH = '#/components/parameters/IfMatch';
const IDEMPOTENCY_KEY = '#/components/parameters/IdempotencyKey';
const NESTS = [
  ['arrays', (depth: number) => `${'['.repeat(depth)}${']'.repeat(depth)}`, 30_000],
  ['objects', (depth: number) => `${'{"a":'.repeat(depth)}1${'}'.repeat(depth)}`, 10_000],
] as const;

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

  it.each(NESTS)(
    'answers %s nested to the size limit with a 400 problem and keeps serving',
    async (_kind, nest, depth) => {
      const payload = `{"email":${nest(depth)},"password":"correct horse battery","client":"ios"}`;
      expect(payload.length).toBeLessThan(BODY_LIMIT_BYTES);

      const result = await login(payload);

      expect(result.status).toBe(400);
      expect(result.body).toContain('urn:questline:problem:validation');
      expect(result.alive).toBe(200);
    },
  );
});

/**
 * The same on every operation with a body, as a logged-in user with the goal-content consent and every documented
 * precondition header, so that the hostile body is what the request is judged by (D-02).
 */
describe('request body limits across the contract [D-02]', () => {
  let ctx: AccountsApp;
  let user: GoalUser;
  const operations = specOperations.filter(
    (operation) => operation.hasRequestBody && !NOT_YET_IMPLEMENTED.has(operation.operationId),
  );
  const cases = operations.flatMap((operation) =>
    NESTS.map(([kind, nest, depth]) => [operation.operationId, kind, operation, nest(depth)] as const),
  );

  beforeAll(async () => {
    ctx = await startAccountsApp();
    user = await goalUser(ctx);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('covers every operation with a body', () => {
    expect(operations.length).toBeGreaterThanOrEqual(19);
  });

  it.each(cases)('%s answers %s nested to the size limit with a 400 problem and keeps serving', async (...args) => {
    const [, , operation, nested] = args;
    const field = Object.keys(operation.requestBodySchema?.['properties'] ?? {})[0] ?? 'value';
    const payload = `{"${field}":${nested}}`;
    expect(payload.length).toBeLessThan(BODY_LIMIT_BYTES);

    const response = await ctx.app.inject({
      method: operation.method as 'POST',
      url: operation.path.replace(/\{[^}]+\}/g, () => randomUUID()),
      headers: {
        ...json,
        ...(operation.requiresAuth ? bearer(user.token) : {}),
        ...(operation.parameters.includes(IF_MATCH) ? { 'if-match': '"1"' } : {}),
        ...(operation.parameters.includes(IDEMPOTENCY_KEY) ? { 'idempotency-key': randomUUID() } : {}),
      },
      payload,
    });
    const health = await ctx.app.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ type: 'urn:questline:problem:validation' });
    expect(health.statusCode).toBe(200);
  });
});
