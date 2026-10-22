import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, LEAKY_ERROR_MESSAGE, UUID_V4 } from '../helpers/app.ts';
import { LogCapture } from '../helpers/log-capture.ts';

const ALLOWED_REQUEST_LOG_KEYS = [
  'duration_ms',
  'level',
  'method',
  'msg',
  'request_id',
  'route',
  'service',
  'status',
  'time',
];

describe('request logging [R-LOG-01, R-LOG-02, I-02]', () => {
  let app: FastifyInstance | undefined;
  let logs: LogCapture;

  afterEach(async () => {
    await app?.close();
  });

  const start = async () => {
    logs = new LogCapture();
    app = await buildTestApp({ logCapture: logs });
    return app;
  };

  const requestLines = () => logs.records().filter((record) => record['msg'] === 'request completed');

  it('logs one allowlisted line per request with the route pattern, never the raw URL', async () => {
    const server = await start();
    await server.inject({ method: 'GET', url: '/__test/items/ItemIdValue77?token=QueryTokenValue' });

    const lines = requestLines();
    expect(lines).toHaveLength(1);
    expect(Object.keys(lines[0] ?? {}).sort()).toEqual(ALLOWED_REQUEST_LOG_KEYS);
    expect(lines[0]).toMatchObject({
      level: 'info',
      service: 'questline-api',
      request_id: expect.stringMatching(UUID_V4) as unknown,
      method: 'GET',
      route: '/__test/items/:id',
      status: 200,
    });
    expect(logs.text).not.toContain('ItemIdValue77');
    expect(logs.text).not.toContain('QueryTokenValue');
  });

  it('never logs headers, bodies, query strings, tokens or emails', async () => {
    const server = await start();
    await server.inject({
      method: 'POST',
      url: '/__test/echo?email=query@example.test',
      headers: {
        authorization: 'Bearer ql_at_AuthorizationSecretValue',
        cookie: 'sid=CookieSecretValue',
        'x-api-key': 'HeaderSecretValue',
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ password: 'BodyPasswordValue', email: 'body@example.test' }),
    });

    for (const value of [
      'AuthorizationSecretValue',
      'CookieSecretValue',
      'HeaderSecretValue',
      'BodyPasswordValue',
      'body@example.test',
      'query@example.test',
    ]) {
      expect(logs.text).not.toContain(value);
    }
    expect(requestLines()[0]).toMatchObject({ method: 'POST', route: '/__test/echo', status: 200 });
  });

  it('logs unexpected errors by name and code only', async () => {
    const server = await start();
    await server.inject({ method: 'GET', url: '/__test/boom' });

    const errorLine = logs.records().find((record) => record['level'] === 'error');
    expect(errorLine).toMatchObject({ msg: 'request failed', err: { name: 'Error' } });
    expect(logs.text).not.toContain(LEAKY_ERROR_MESSAGE);
    expect(logs.text).not.toContain('secret.ts');
    expect(requestLines()[0]).toMatchObject({ route: '/__test/boom', status: 500 });
  });

  it('logs unmatched routes without their path', async () => {
    const server = await start();
    await server.inject({ method: 'GET', url: '/users/alice@example.test/secrets' });

    expect(requestLines()[0]).toMatchObject({ route: null, status: 404 });
    expect(logs.text).not.toContain('alice@example.test');
  });
});
