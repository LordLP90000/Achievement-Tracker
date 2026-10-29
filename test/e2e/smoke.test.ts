import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer, type AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const COMPOSE = ['compose', '-f', 'docker/compose.yml', '-p', 'questline-e2e'];
const MAX_BUFFER = 64 * 1024 * 1024;
const secret = () => randomBytes(24).toString('base64url');

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  return port;
}

/** Builds the image, starts the Compose stack and checks the running containers [E-06, R-SUP-03, I-02]. */
describe('container smoke test', () => {
  const secrets = {
    POSTGRES_ADMIN_PASSWORD: secret(),
    DB_PASSWORD_MIGRATOR: secret(),
    DB_PASSWORD_APP: secret(),
    DB_PASSWORD_WORKER: secret(),
  };
  const env: NodeJS.ProcessEnv = { ...process.env, ...secrets };
  let baseUrl = '';

  const compose = (...args: string[]) => run('docker', [...COMPOSE, ...args], { env, maxBuffer: MAX_BUFFER });
  const inApi = (...command: string[]) => compose('exec', '-T', 'api', ...command);
  // The distroless runtime contains no shell or coreutils; Node.js is the only executable.
  const inApiNode = (script: string) => inApi('/nodejs/bin/node', '-e', script);

  beforeAll(async () => {
    env['API_PORT'] = String(await freePort());
    baseUrl = `http://127.0.0.1:${env['API_PORT']}`;
    await compose('up', '--build', '--detach', '--wait');
  });

  afterAll(async () => {
    await compose('down', '--volumes', '--remove-orphans');
  });

  it('serves readiness from the built image with the security headers', async () => {
    const response = await fetch(`${baseUrl}/health/ready`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('runs the API as a non-root user [E-06]', async () => {
    const { stdout } = await inApiNode('process.stdout.write(String(process.getuid()))');

    expect(stdout.trim()).toMatch(/^[1-9]\d*$/);
  });

  it('has a read-only root filesystem and a writable /tmp [E-06, R-SUP-03]', async () => {
    await expect(inApiNode("require('node:fs').writeFileSync('/app/intruder', 'x')")).rejects.toThrow();
    await expect(inApiNode("require('node:fs').writeFileSync('/tmp/allowed', 'x')")).resolves.toBeDefined();
  });

  it('contains no shell and no package manager [E-06]', async () => {
    await expect(inApi('/bin/sh', '-c', 'true')).rejects.toThrow();
    await expect(inApi('sh', '-c', 'true')).rejects.toThrow();
    await expect(inApi('npm', '--version')).rejects.toThrow();
  });

  it('loads libsodium with guarded memory from the only native prebuild left in the image [ADR-0005]', async () => {
    const { stdout } = await inApiNode(
      [
        "const sodium = require('/app/node_modules/sodium-native');",
        "const prebuilds = require('node:fs').readdirSync('/app/node_modules/sodium-native/prebuilds');",
        'const platform = `${process.platform}-${process.arch}`;',
        'process.stdout.write(JSON.stringify({ secure: sodium.sodium_malloc(32).secure, prebuilds, platform }));',
      ].join(' '),
    );
    const result = JSON.parse(stdout) as { secure: boolean; prebuilds: string[]; platform: string };

    expect(result.secure).toBe(true);
    expect(result.prebuilds).toEqual([result.platform]);
  });

  it('keeps the database, the API and the worker running', async () => {
    const { stdout } = await compose('ps', '--status', 'running', '--services');

    expect(stdout.split(/\r?\n/).filter(Boolean).sort()).toEqual(['api', 'db', 'worker']);
  });

  it('never writes a password to any container log', async () => {
    const { stdout, stderr } = await compose('logs', '--no-color');

    for (const value of Object.values(secrets)) {
      expect(stdout + stderr).not.toContain(value);
    }
  });

  it('refuses to start in production with weak settings and prints no secret [E-08]', async () => {
    const weak = 'WeakSecretValue1';
    const failure = (await run('docker', [
      'run',
      '--rm',
      '-e',
      'APP_ENV=production',
      '-e',
      `DATABASE_URL_APP=postgres://questline_app:${weak}@db/questline`,
      'questline-api:local',
    ]).catch((error: unknown) => error)) as { code?: number; stdout?: string; stderr?: string };

    expect(failure.code).toBe(1);
    expect(failure.stderr).toContain('Invalid configuration');
    expect(`${failure.stdout ?? ''}${failure.stderr ?? ''}`).not.toContain(weak);
  });
});
