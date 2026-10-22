import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp } from '../helpers/app.ts';
import { contractInject } from '../helpers/contract.ts';
import { LogCapture } from '../helpers/log-capture.ts';

describe('health endpoints [A-18, I-15]', () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
  });

  it('reports liveness with a status only', async () => {
    app = await buildTestApp();
    const response = await contractInject(app, { method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"status":"ok"}');
  });

  it('reports readiness when the readiness probe passes', async () => {
    app = await buildTestApp({ readiness: () => Promise.resolve(true) });
    const response = await contractInject(app, { method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('{"status":"ok"}');
  });

  it('answers 503 degraded when the probe reports not ready', async () => {
    app = await buildTestApp({ readiness: () => Promise.resolve(false) });
    const response = await contractInject(app, { method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.body).toBe('{"status":"degraded"}');
  });

  it('answers 503 and logs only the error name when the probe throws', async () => {
    const logs = new LogCapture();
    app = await buildTestApp({
      logCapture: logs,
      readiness: () => Promise.reject(new Error('connect ECONNREFUSED db.internal:5432 password=LeakedValue1')),
    });
    const response = await contractInject(app, { method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.body).toBe('{"status":"degraded"}');
    expect(logs.records().find((record) => record['msg'] === 'readiness check failed')).toMatchObject({
      level: 'warn',
      err: { name: 'Error' },
    });
    expect(logs.text).not.toContain('LeakedValue1');
    expect(logs.text).not.toContain('db.internal');
  });

  it('answers 503 when the probe does not finish in time', async () => {
    const logs = new LogCapture();
    app = await buildTestApp({
      logCapture: logs,
      readiness: () => new Promise<boolean>(() => undefined),
      readinessTimeoutMs: 20,
    });
    const response = await contractInject(app, { method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(logs.records().some((record) => record['msg'] === 'readiness check timed out')).toBe(true);
  });

  it('answers undocumented methods with a 404 problem', async () => {
    app = await buildTestApp();
    const response = await contractInject(app, { method: 'POST', url: '/health/live' });

    expect(response.statusCode).toBe(404);
  });
});
