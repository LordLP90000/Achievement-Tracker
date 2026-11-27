import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('asks the dependencies once for probes that arrive together [D-10]', async () => {
    let asked = 0;
    let release: (ready: boolean) => void = () => undefined;
    app = await buildTestApp({
      readiness: () => {
        asked += 1;
        return new Promise<boolean>((resolve) => {
          release = resolve;
        });
      },
    });
    const server = app;
    const probes = Array.from({ length: 25 }, () => contractInject(server, { method: 'GET', url: '/health/ready' }));
    await vi.waitFor(() => {
      expect(asked).toBeGreaterThan(0);
    });
    // Without sharing, the other 24 probes reach the database within this pause.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(asked).toBe(1);

    release(true);

    expect((await Promise.all(probes)).map((response) => response.statusCode)).toEqual(Array(25).fill(200));
    expect(asked).toBe(1);
  });

  it('gives the same answer for one second, with one warning, then asks again [D-10]', async () => {
    const logs = new LogCapture();
    let now = 5000;
    let asked = 0;
    app = await buildTestApp({
      logCapture: logs,
      monotonicNow: () => now,
      readiness: () => {
        asked += 1;
        return Promise.resolve(asked > 1);
      },
    });
    const probe = { method: 'GET', url: '/health/ready' } as const;
    const warnings = (): number => logs.records().filter((record) => record['level'] === 'warn').length;

    for (const elapsed of [0, 500, 499]) {
      now += elapsed;
      expect((await contractInject(app, probe)).statusCode).toBe(503);
    }
    expect(asked).toBe(1);
    expect(warnings()).toBe(1);

    now += 1;
    const later = await contractInject(app, probe);

    expect(later.statusCode).toBe(200);
    expect(later.body).toBe('{"status":"ok"}');
    expect(asked).toBe(2);
    expect(warnings()).toBe(1);
  });

  it('answers undocumented methods with a 404 problem', async () => {
    app = await buildTestApp();
    const response = await contractInject(app, { method: 'POST', url: '/health/live' });

    expect(response.statusCode).toBe(404);
  });
});
