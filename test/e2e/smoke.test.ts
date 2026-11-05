import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { request } from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { xpAboveLevel } from '../../src/domain/xp.ts';
import { checkPassword, loadBreachedPasswordFilter } from '../../src/modules/accounts/password-policy.ts';
import { retentionJobs } from '../../src/modules/privacy/retention.ts';

const run = promisify(execFile);
const COMPOSE = ['compose', '-f', 'docker/compose.yml', '-p', 'questline-e2e'];
const MAX_BUFFER = 64 * 1024 * 1024;
const secret = () => randomBytes(24).toString('base64url');
const key = () => randomBytes(32).toString('base64');
const zurichDate = (instant: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich' }).format(instant);
/** The worker polls the outbox every 5 s (`OUTBOX_POLL_MS`). */
const MAIL_WAIT_MS = 30_000;
const DAY_MS = 86_400_000;

/** Plaintext SMTP to the mail catcher from inside the network: a plaintext server would answer within 2 s. */
const PLAINTEXT_SMTP_PROBE = [
  "const socket = require('node:net').connect(1025, 'mailpit');",
  "let received = '';",
  "socket.setEncoding('latin1');",
  "socket.on('connect', () => socket.write('EHLO probe\\r\\n'));",
  "socket.on('data', (chunk) => { received += chunk; });",
  "socket.on('error', () => undefined);",
  'setTimeout(() => { console.log(JSON.stringify({ smtpReply: /^\\d{3}[ -]/m.test(received) })); process.exit(0); }, 2000);',
].join(' ');

/** A random password the offline breach filter accepts: about 1 % of random strings are false positives (ADR-0012). */
function acceptedPassword(): string {
  const breached = loadBreachedPasswordFilter();
  let candidate = secret();
  while (checkPassword(breached, candidate) !== 'ok') candidate = secret();
  return candidate;
}

/** The status of a GET with the given `Host` header, which `fetch` would not send. */
function statusWithHost(url: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const sent = request(url, { headers: { host } }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    sent.on('error', reject);
    sent.end();
  });
}

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
    LOCAL_KEK: key(),
    BLIND_INDEX_KEY: key(),
    RATE_LIMIT_KEY: key(),
    MAIL_CATCHER_PASSWORD: secret(),
  };
  const env: NodeJS.ProcessEnv = { ...process.env, ...secrets };
  let baseUrl = '';
  let mailUrl = '';

  const compose = (...args: string[]) => run('docker', [...COMPOSE, ...args], { env, maxBuffer: MAX_BUFFER });
  const inApi = (...command: string[]) => compose('exec', '-T', 'api', ...command);
  // The distroless runtime contains no shell or coreutils; Node.js is the only executable.
  const inApiNode = (script: string) => inApi('/nodejs/bin/node', '-e', script);
  const sqlIn = async (database: string, query: string) =>
    (await compose('exec', '-T', 'db', 'psql', '-U', 'postgres', '-d', database, '-tAc', query)).stdout.trim();
  const sql = (query: string) => sqlIn('questline', query);

  interface Request {
    readonly token?: string;
    readonly body?: unknown;
    /** Sends a fresh `Idempotency-Key`, as every create needs. */
    readonly create?: boolean;
    /** Otherwise GET without a body and POST with one. */
    readonly method?: 'DELETE';
  }
  const api = (path: string, { token, body, create = false, method }: Request = {}) =>
    fetch(`${baseUrl}${path}`, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        ...(create ? { 'idempotency-key': randomUUID() } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

  interface Mail {
    readonly ID: string;
  }
  /** The emails the catcher holds for the address, once there are `count` of them (or the wait is over). */
  const mailsTo = async (address: string, count: number): Promise<readonly Mail[]> => {
    const url = `${mailUrl}/api/v1/search?query=${encodeURIComponent(`to:"${address}"`)}`;
    const deadline = Date.now() + MAIL_WAIT_MS;
    for (;;) {
      const { messages } = (await (await fetch(url)).json()) as { messages: Mail[] };
      if (messages.length >= count || Date.now() > deadline) return messages;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };
  const mailText = async (mail: Mail | undefined) =>
    ((await (await fetch(`${mailUrl}/api/v1/message/${mail?.ID ?? 'none'}`)).json()) as { Text: string }).Text;
  const waitFor = async (probe: () => Promise<string>, done: (value: string) => boolean) => {
    let value = await probe();
    for (let attempt = 0; attempt < 60 && !done(value); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      value = await probe();
    }
    return value;
  };

  interface SignedUp {
    readonly email: string;
    readonly password: string;
    readonly accessToken: string;
    readonly id: string;
  }
  /** A new account, verified through the emailed link and signed in. */
  const signedUp = async (label: string): Promise<SignedUp> => {
    const email = `${label}-${randomBytes(6).toString('hex')}@example.test`;
    const password = acceptedPassword();
    await api('/v1/auth/register', {
      body: { email, password, privacy_policy_version: '2026-10-01', age_confirmed: true },
    });
    const [verification] = await mailsTo(email, 1);
    const token = /#token=([\w-]+)/.exec(await mailText(verification))?.[1] ?? 'missing';
    await api('/v1/auth/verify-email', { body: { token } });
    const login = await api('/v1/auth/login', { body: { email, password, client: 'ios' } });
    const { access_token: accessToken } = (await login.json()) as { access_token: string };
    const { id } = (await (await api('/v1/me', { token: accessToken })).json()) as { id: string };
    return { email, password, accessToken, id };
  };
  const loginStatus = async ({ email, password }: SignedUp) =>
    (await api('/v1/auth/login', { body: { email, password, client: 'ios' } })).status;

  beforeAll(async () => {
    env['API_PORT'] = String(await freePort());
    env['MAIL_UI_PORT'] = String(await freePort());
    baseUrl = `http://127.0.0.1:${env['API_PORT']}`;
    mailUrl = `http://127.0.0.1:${env['MAIL_UI_PORT']}`;
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

  it('keeps the database, the API, the worker and the mail catcher running', async () => {
    const { stdout } = await compose('ps', '--status', 'running', '--services');

    expect(stdout.split(/\r?\n/).filter(Boolean).sort()).toEqual(['api', 'db', 'mailpit', 'worker']);
  });

  it('runs every scheduled job in the worker container with the worker role [R-PRIV-07, A-20, ADR-0009]', async () => {
    // The retention jobs and the daily goal evaluation.
    const expected = String(retentionJobs().length + 1);
    const succeededJobs = () => sql("select count(distinct job_name) from job_runs where status = 'succeeded'");
    let succeeded = await succeededJobs();
    for (let attempt = 0; attempt < 20 && succeeded !== expected; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      succeeded = await succeededJobs();
    }

    expect(succeeded).toBe(expected);
    const { stdout } = await compose('logs', '--no-color', 'worker');
    expect(stdout).toContain('"email_delivery":"on"');
  });

  it('runs the mail catcher with TLS-only SMTP and its web UI on 127.0.0.1 only [E-12, Q-45]', async () => {
    const { stdout: published } = await compose('port', 'mailpit', '8025');
    const { stdout: probe } = await compose('exec', '-T', 'worker', '/nodejs/bin/node', '-e', PLAINTEXT_SMTP_PROBE);

    expect(published.trim()).toBe(`127.0.0.1:${env['MAIL_UI_PORT'] ?? ''}`);
    expect(JSON.parse(probe)).toEqual({ smtpReply: false });
    // Only requests for the published address are answered, against DNS rebinding.
    expect(await statusWithHost(`${mailUrl}/api/v1/messages`, 'attacker.example')).toBe(403);
  });

  it('registers an account in the built image: one user, its data key, both emails delivered over TLS, nothing logged [R-AUTH-07, R-LOG-02]', async () => {
    const email = `e2e-${randomBytes(6).toString('hex')}@example.test`;
    const password = acceptedPassword();
    const register = (chosen: string) =>
      api('/v1/auth/register', {
        body: { email, password: chosen, privacy_policy_version: '2026-10-01', age_confirmed: true },
      });

    const first = await register(password);
    const again = await register(password);
    const breached = await register('password1234');

    expect([first.status, again.status, breached.status]).toEqual([202, 202, 422]);
    expect(await again.json()).toEqual(await first.json());
    expect(await sql("select (select count(*) from users) || ' ' || (select count(*) from user_keys)")).toBe('1 1');
    // The verification link, and the notice that someone tried again, which never carries a link (A-33).
    const texts = await Promise.all((await mailsTo(email, 2)).map(mailText));
    expect(texts.map((text) => /\/verify-email#token=[\w-]+/.test(text)).sort()).toEqual([false, true]);
    // A sent email leaves the outbox at once; the catcher may hold it a moment before the worker commits that.
    let queued = await sql('select count(*) from email_outbox');
    for (let attempt = 0; attempt < 20 && queued !== '0'; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      queued = await sql('select count(*) from email_outbox');
    }
    expect(queued).toBe('0');
    const logs = await compose('logs', '--no-color');
    for (const value of [email, password]) expect(logs.stdout + logs.stderr).not.toContain(value);
  });

  it('takes a new user from sign-up through the emailed link to their stats, data export and account deletion: the app journey [Q-45, R-PRIV-05, R-PRIV-06]', async () => {
    const email = `journey-${randomBytes(6).toString('hex')}@example.test`;
    const password = acceptedPassword();
    const today = zurichDate(new Date());

    const registered = await api('/v1/auth/register', {
      body: { email, password, privacy_policy_version: '2026-10-01', age_confirmed: true },
    });
    const [verification] = await mailsTo(email, 1);
    const token = /#token=([\w-]+)/.exec(await mailText(verification))?.[1] ?? 'missing';
    const verified = await api('/v1/auth/verify-email', { body: { token } });
    const login = await api('/v1/auth/login', { body: { email, password, client: 'ios' } });
    const { access_token: accessToken } = (await login.json()) as { access_token: string };
    const consent = await api('/v1/me/consents', {
      token: accessToken,
      body: { type: 'goal_content', version: '2026-10-01' },
    });
    const achievement = await api('/v1/achievements', {
      token: accessToken,
      create: true,
      body: { title: 'Run a half marathon', target_date: zurichDate(new Date(Date.now() + 30 * DAY_MS)) },
    });
    const { id: achievementId } = (await achievement.json()) as { id: string };
    const questIds: string[] = [];
    for (const title of ['Run 10 km', 'Run 21 km']) {
      const quest = await api(`/v1/achievements/${achievementId}/quests`, {
        token: accessToken,
        create: true,
        body: { title, type: 'one_time', size: 'M' },
      });
      questIds.push(((await quest.json()) as { id: string }).id);
    }
    const checkIn = (questId = 'missing') =>
      api(`/v1/quests/${questId}/check-ins`, { token: accessToken, create: true, body: { local_date: today } });
    const firstCheckIn = await checkIn(questIds[0]);
    const gamble = await api(`/v1/achievements/${achievementId}/gambles`, {
      token: accessToken,
      create: true,
      body: {},
    });
    const unlock = await checkIn(questIds[1]);
    const stats = await api('/v1/me/stats', { token: accessToken });
    // The login above was the password entry the export needs (R-AUTH-06).
    const exported = await api('/v1/me/export', { token: accessToken });
    const deleted = await api('/v1/me', { token: accessToken, method: 'DELETE' });
    const afterDeletion = await api('/v1/me', { token: accessToken });

    expect(
      [registered, verified, login, consent, achievement, firstCheckIn, gamble, unlock, stats, exported].map(
        (r) => r.status,
      ),
    ).toEqual([202, 204, 200, 201, 201, 201, 201, 201, 200, 200]);
    expect(await gamble.json()).toMatchObject({ status: 'pending', stake: xpAboveLevel(25) });
    // Within 7 × 24 h of its creation an unlock pays no rank bonus and the win pays nothing (A-34).
    expect(await unlock.json()).toMatchObject({ achievement_unlocked: true, gamble: { outcome: 'won', xp_delta: 0 } });
    expect(await stats.json()).toMatchObject({ xp_total: 50, gambles: { won: 1, lost: 0 } });
    expect(await exported.json()).toMatchObject({
      account: { email },
      achievements: [{ title: 'Run a half marathon', status: 'completed', gambles: [{ status: 'won' }] }],
    });
    // Deactivated at once, every session ended, and the owner told the deadline by email (R-PRIV-06, E-13).
    expect([deleted.status, afterDeletion.status]).toEqual([202, 401]);
    const { deletion_scheduled_for: deadline } = (await deleted.json()) as { deletion_scheduled_for: string };
    expect(Math.abs(Date.parse(deadline) - (Date.now() + 30 * DAY_MS))).toBeLessThan(60_000);
    const texts = await Promise.all((await mailsTo(email, 2)).map(mailText));
    expect(texts.filter((text) => text.includes('in 30 Tagen'))).toHaveLength(1);
    const logs = await compose('logs', '--no-color');
    for (const value of [email, password, token]) expect(logs.stdout + logs.stderr).not.toContain(value);
  });

  it('rehearses a restore: a backup, an account deleted for good after it, the restore and the tombstone replay — that account is gone again, the rest kept [Q-13, I-18, RR-4, ADR-0020]', async () => {
    const kept = await signedUp('kept');
    const deleted = await signedUp('deleted');
    const maintenance = (...options: string[]) =>
      compose('run', '--rm', '--no-deps', '-T', ...options, 'migrate', 'dist/maintenance.js', 'replay-tombstones');
    const tombstone = () =>
      sql(`select to_char(deleted_at, 'YYYY-MM-DD HH24:MI:SS.US') from deleted_user_tombstones
           where user_id = '${deleted.id}'`);

    // The image's maintenance entrypoint refuses while the API and the worker are connected (ADR-0020).
    const refused = (await maintenance().catch((error: unknown) => error)) as { code?: number; stderr?: string };
    // The backup: a dump of the whole database.
    await compose('exec', '-T', 'db', 'pg_dump', '-U', 'postgres', '-d', 'questline', '-Fc', '-f', '/tmp/q.dump');
    // After it, the account is deleted for good: its request moved 30 days back, and the worker, restarted, runs
    // the hourly hard delete at once.
    const deletion = await api('/v1/me', { token: deleted.accessToken, method: 'DELETE' });
    await sql(`update users set deactivated_at = deactivated_at - interval '30 days' where id = '${deleted.id}'`);
    await sql("delete from job_runs where job_name = 'purge_deleted_accounts'");
    await compose('restart', 'worker');
    const deletedAt = await waitFor(tombstone, (value) => value !== '');
    // The restore (docs/runbooks/restore.md): the API and the worker stopped, the dump restored into a new database
    // that takes the old one's name, the bootstrap run again for the database's access rights, then the replay.
    await compose('stop', 'api', 'worker');
    await sqlIn('postgres', 'create database questline_restored owner questline_migrator');
    await compose('exec', '-T', 'db', 'pg_restore', '-U', 'postgres', '-d', 'questline_restored', '-e', '/tmp/q.dump');
    await sqlIn('postgres', 'alter database questline rename to questline_replaced');
    await sqlIn('postgres', 'alter database questline_restored rename to questline');
    const bootstrapped = await compose('run', '--rm', '--no-deps', '-T', 'db-init');
    const restoredAccounts = await sql(`select count(*) from users where id in ('${kept.id}', '${deleted.id}')`);
    const source = `TOMBSTONE_SOURCE_DATABASE_URL=postgres://questline_worker:${secrets.DB_PASSWORD_WORKER}@db:5432/questline_replaced`;
    const replayed = await maintenance('-e', source);
    const again = await maintenance('-e', source);
    await compose('up', '--detach', '--wait', '--no-deps', 'api', 'worker');

    expect(refused.code).toBe(1);
    // Compose reports the run container on stderr as well.
    expect(refused.stderr).toContain('Startup failed (MaintenanceRefusedError: processes_connected).');
    expect([deletion.status, deletedAt === '']).toEqual([202, false]);
    // The backup still holds the account the restore brings back, and the replay deletes it again.
    expect(restoredAccounts).toBe('2');
    expect(replayed.stdout).toContain('"imported":1,"deleted":1,"msg":"tombstones replayed"');
    expect(again.stdout).toContain('"imported":0,"deleted":0,"msg":"tombstones replayed"');
    expect(await sql(`select count(*) from users where id = '${deleted.id}'`)).toBe('0');
    // Its tombstone kept its date, so it still expires 35 days after the deletion.
    expect(await tombstone()).toBe(deletedAt);
    expect([await loginStatus(kept), await loginStatus(deleted)]).toEqual([200, 401]);
    // As locked down as before the restore: no access to the database for PUBLIC.
    expect(await sqlIn('postgres', "select datacl::text from pg_database where datname = 'questline'")).not.toMatch(
      /[{,]=/,
    );
    for (const output of [replayed, again, bootstrapped]) {
      for (const value of [...Object.values(secrets), kept.id, deleted.id, deleted.email]) {
        expect(output.stdout + output.stderr).not.toContain(value);
      }
    }
  }, 240_000);

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

  it('refuses to start when the KEK cannot be obtained, naming the reason but never the token [E-11, R-ENC-05]', async () => {
    const token = secret();
    const failure = (await run('docker', [
      'run',
      '--rm',
      ...['-e', 'APP_ENV=development', '-e', 'DATABASE_URL_APP=postgres://questline_app:x@db/questline'],
      ...['-e', 'KEK_SOURCE=onepassword-connect', '-e', 'OP_CONNECT_URL=http://127.0.0.1:9'],
      ...['-e', `OP_CONNECT_TOKEN=${token}`, '-e', 'OP_KEK_VAULT_ID=a1b2c3d4e5f6g7h8i9j0k1l2m3'],
      ...['-e', 'OP_KEK_ITEM_ID=z9y8x7w6v5u4t3s2r1q0p9o8n7'],
      ...['-e', `BLIND_INDEX_KEY=${key()}`, '-e', `RATE_LIMIT_KEY=${key()}`],
      'questline-api:local',
    ]).catch((error: unknown) => error)) as { code?: number; stdout?: string; stderr?: string };

    expect(failure.code).toBe(1);
    expect(failure.stderr?.trim()).toBe('Startup failed (KekSourceError: connect_unreachable).');
    expect(`${failure.stdout ?? ''}${failure.stderr ?? ''}`).not.toContain(token);
  });
});
