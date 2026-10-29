import { randomBytes, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { startApi, type ApiKeyMaterial } from '../../src/main/api.ts';
import { bootstrapCommand, migrateCommand } from '../../src/main/database.ts';
import { startWorker } from '../../src/main/worker.ts';
import { envKekSource } from '../../src/platform/crypto/kek-source.ts';
import { dropDatabase } from '../../src/platform/db/bootstrap.ts';
import type { ApiConfig } from '../../src/platform/config/config.ts';
import { createLogger } from '../../src/platform/logging/logger.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/database.ts';
import { LogCapture } from '../helpers/log-capture.ts';

describe('entrypoints against a real database', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database.drop();
  });

  const loggerFor = (logs: LogCapture) => createLogger({ service: 'questline-api', level: 'info' }, logs.stream);
  const keys = async (): Promise<ApiKeyMaterial> => ({
    kek: await envKekSource(randomBytes(32))(),
    blindIndexKey: randomBytes(32),
    rateLimitKey: randomBytes(32),
  });

  it('starts the API on a real socket, serves readiness with security headers and stops cleanly', async () => {
    const config: ApiConfig = {
      appEnv: 'test',
      logLevel: 'info',
      http: { host: '127.0.0.1', port: 0, trustProxyHops: 0 },
      databaseUrl: database.urls.app,
    };
    const logs = new LogCapture();
    const api = await startApi(config, await keys(), loggerFor(logs));

    const response = await fetch(`${api.url}/health/ready`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(response.headers.get('strict-transport-security')).toContain('max-age=63072000');
    expect(logs.records().some((record) => record['msg'] === 'api listening')).toBe(true);

    await api.stop();
    await expect(fetch(`${api.url}/health/live`)).rejects.toThrow();
  });

  it('announces the API once, with its port but without network addresses [Q-28]', async () => {
    const config: ApiConfig = {
      appEnv: 'test',
      logLevel: 'info',
      http: { host: '127.0.0.1', port: 0, trustProxyHops: 0 },
      databaseUrl: database.urls.app,
    };
    const logs = new LogCapture();
    const api = await startApi(config, await keys(), loggerFor(logs));
    await api.stop();

    expect(logs.records().filter((record) => record['msg'] === 'api listening')).toMatchObject([
      { port: expect.any(Number) as unknown },
    ]);
    expect(logs.text).not.toContain('Server listening');
    expect(logs.text).not.toMatch(/\b\d{1,3}(?:\.\d{1,3}){3}\b/);
  });

  it('fails to start when the port is taken and leaves no open database pool behind', async () => {
    const config: ApiConfig = {
      appEnv: 'test',
      logLevel: 'info',
      http: { host: '127.0.0.1', port: 0, trustProxyHops: 0 },
      databaseUrl: database.urls.app,
    };
    const first = await startApi(config, await keys(), loggerFor(new LogCapture()));
    const takenPort = Number(new URL(first.url).port);

    await expect(
      startApi({ ...config, http: { ...config.http, port: takenPort } }, await keys(), loggerFor(new LogCapture())),
    ).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await first.stop();
  });

  it('starts the worker with the worker role and stops it', async () => {
    const logs = new LogCapture();
    const worker = await startWorker(
      { appEnv: 'test', logLevel: 'info', databaseUrl: database.urls.worker, email: undefined },
      { kek: (await keys()).kek },
      loggerFor(logs),
    );

    expect(logs.records().map((record) => record['msg'])).toContain('worker ready');
    await expect(worker.stop()).resolves.toBeUndefined();
  });

  it('refuses to start the worker when its database is unreachable', async () => {
    await expect(
      startWorker(
        {
          appEnv: 'test',
          logLevel: 'info',
          databaseUrl: 'postgres://nobody:nothing@127.0.0.1:1/none',
          email: undefined,
        },
        { kek: (await keys()).kek },
        loggerFor(new LogCapture()),
      ),
    ).rejects.toThrow();
  });

  it('applies migrations idempotently', async () => {
    const logs = new LogCapture();

    await migrateCommand({ appEnv: 'test', logLevel: 'info', databaseUrl: database.urls.migrator }, loggerFor(logs));

    expect(logs.records().map((record) => record['msg'])).toContain('migrations applied');
  });

  it('bootstraps a database idempotently', async () => {
    const server = inject('database');
    const name = `bootstrap_${randomUUID().replaceAll('-', '')}`;
    const logs = new LogCapture();
    const config = { appEnv: 'test' as const, logLevel: 'info' as const, adminUrl: server.adminUrl, database: name };

    await bootstrapCommand({ ...config, passwords: server.passwords }, loggerFor(logs));
    await bootstrapCommand({ ...config, passwords: server.passwords }, loggerFor(logs));

    expect(logs.records().filter((record) => record['msg'] === 'database bootstrapped')).toHaveLength(2);
    await dropDatabase(server.adminUrl, name);
  });
});
