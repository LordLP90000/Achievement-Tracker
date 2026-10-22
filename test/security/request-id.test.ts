import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, UUID_V4 } from '../helpers/app.ts';

describe('request IDs [R-LOG-01, R-OUT-02]', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  const requestIdOf = async (headers: Record<string, string> = {}) => {
    const response = await app.inject({ method: 'GET', url: '/nope', headers });
    return { response, requestId: response.json<{ request_id: string }>().request_id };
  };

  it('assigns a fresh random UUID v4 to every request', async () => {
    const ids = await Promise.all(Array.from({ length: 25 }, async () => (await requestIdOf()).requestId));

    expect(new Set(ids).size).toBe(25);
    for (const id of ids) expect(id).toMatch(UUID_V4);
  });

  it('ignores request IDs supplied by the client', async () => {
    const supplied = 'attacker-chosen-request-id';
    const { response, requestId } = await requestIdOf({ 'x-request-id': supplied, 'request-id': supplied });

    expect(requestId).toMatch(UUID_V4);
    expect(response.body).not.toContain(supplied);
    expect(JSON.stringify(response.headers)).not.toContain(supplied);
  });
});
