/**
 * Load, limit and DAST runs against the local Compose stack (M6, Q-58): `npm run test:load` runs k6
 * (`test/perf/limits.js`), `npm run test:dast` the ZAP API scan with the OpenAPI contract. Both tools run as
 * hardened containers from images pinned by digest, on an internal network they share with the API alone (Q-58,
 * Q-59), and write their reports to `reports/`. The stack starts with fresh throw-away secrets and is removed
 * afterwards, volumes included.
 */
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { checkPassword, loadBreachedPasswordFilter } from '../../src/modules/accounts/password-policy.ts';

/** grafana/k6 2.3.0, published 2026-10-24. */
const K6_IMAGE = 'grafana/k6@sha256:2dd4756ec6e14e62778916e1eb850108e4b499304c02df56760fa0bdb0fba0b8';
/**
 * ZAP 2.17.0, the `20261026-stable` build. Trivy finds 17 critical and 460 high CVEs in its Debian 12 base, Firefox
 * and OpenJDK: accepted for this test use only, hardened and without internet access (Q-59).
 */
const ZAP_IMAGE = 'ghcr.io/zaproxy/zaproxy@sha256:030d3df57735dacbb83464854758e674dd9ad01d79d12a129a8e58b1fd384238';

const PROJECT = 'questline-perf';
/** The tools' only network: internal (no route out), shared with the API alone, which joins it as `api`. */
const SCAN_NETWORK = `${PROJECT}-scan`;
const COMPOSE = ['compose', '-f', 'docker/compose.yml', '-p', PROJECT];
const LOAD_USERS = 10;
const MAIL_WAIT_MS = 30_000;
const DAY_MS = 86_400_000;
const ZAP_HIGH = '3';

const run = promisify(execFile);
const secret = () => randomBytes(24).toString('base64url');
const key = () => randomBytes(32).toString('base64');
const zurichDate = (instant: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Zurich' }).format(instant);
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  return port;
}

/** Runs a tool container, hardened, on the scan network only; its output passed through; resolves with its exit code. */
function tool(mounts: readonly string[], image: string, command: readonly string[]): Promise<number> {
  const hardened = ['--network', SCAN_NETWORK, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges'];
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['run', '--rm', ...hardened, ...mounts, image, ...command], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      resolve(code ?? 1);
    });
  });
}

interface Account {
  readonly email: string;
  readonly token: string;
}

class Stack {
  readonly #env: NodeJS.ProcessEnv;
  readonly #api: string;
  readonly #mail: string;
  readonly #breached = loadBreachedPasswordFilter();

  private constructor(env: NodeJS.ProcessEnv) {
    this.#env = env;
    this.#api = `http://127.0.0.1:${env['API_PORT'] ?? ''}/v1`;
    this.#mail = `http://127.0.0.1:${env['MAIL_UI_PORT'] ?? ''}`;
  }

  static async create(): Promise<Stack> {
    return new Stack({
      ...process.env,
      POSTGRES_ADMIN_PASSWORD: secret(),
      DB_PASSWORD_MIGRATOR: secret(),
      DB_PASSWORD_APP: secret(),
      DB_PASSWORD_WORKER: secret(),
      LOCAL_KEK: key(),
      BLIND_INDEX_KEY: key(),
      RATE_LIMIT_KEY: key(),
      MAIL_CATCHER_PASSWORD: secret(),
      API_PORT: String(await freePort()),
      MAIL_UI_PORT: String(await freePort()),
    });
  }

  /** Starts the stack, then the internal scan network with the API on it. */
  async start(): Promise<void> {
    await this.compose('up', '--build', '--detach', '--wait');
    const { stdout: api } = await this.compose('ps', '--quiet', 'api');
    await run('docker', ['network', 'rm', '--force', SCAN_NETWORK]);
    await run('docker', ['network', 'create', '--internal', SCAN_NETWORK]);
    await run('docker', ['network', 'connect', '--alias', 'api', SCAN_NETWORK, api.trim()]);
  }

  compose(...args: string[]) {
    return run('docker', [...COMPOSE, ...args], { env: this.#env, maxBuffer: 64 * 1024 * 1024 });
  }

  async stop(): Promise<void> {
    await this.compose('down', '--volumes', '--remove-orphans');
    await run('docker', ['network', 'rm', '--force', SCAN_NETWORK]);
  }

  /** A request from the host; a 429 is waited out as its `Retry-After` says, as a client must. */
  async #call(path: string, body?: unknown, token?: string): Promise<Response> {
    for (;;) {
      const response = await fetch(`${this.#api}${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.status !== 429) return response;
      await pause(Number(response.headers.get('retry-after') ?? '1') * 1000);
    }
  }

  async #verificationToken(email: string): Promise<string> {
    const search = `${this.#mail}/api/v1/search?query=${encodeURIComponent(`to:"${email}"`)}`;
    const deadline = Date.now() + MAIL_WAIT_MS;
    while (Date.now() < deadline) {
      const { messages } = (await (await fetch(search)).json()) as { messages: { ID: string }[] };
      const [message] = messages;
      if (message !== undefined) {
        const { Text } = (await (await fetch(`${this.#mail}/api/v1/message/${message.ID}`)).json()) as { Text: string };
        const token = /#token=([\w-]+)/.exec(Text)?.[1];
        if (token !== undefined) return token;
      }
      await pause(500);
    }
    throw new Error('no verification email arrived');
  }

  /** A verified, signed-in account; with consent to goal content when it will create goals. */
  async account(label: string, consent = false): Promise<Account> {
    const email = `${label}-${randomBytes(6).toString('hex')}@example.test`;
    let password = secret();
    while (checkPassword(this.#breached, password) !== 'ok') password = secret();
    const registered = await this.#call('/auth/register', {
      email,
      password,
      privacy_policy_version: '2026-10-01',
      age_confirmed: true,
    });
    const verified = await this.#call('/auth/verify-email', { token: await this.#verificationToken(email) });
    const login = await this.#call('/auth/login', { email, password, client: 'ios' });
    if ([registered.status, verified.status, login.status].join() !== '202,204,200') {
      throw new Error(
        `sign-up answered ${String(registered.status)}, ${String(verified.status)}, ${String(login.status)}`,
      );
    }
    const { access_token: token } = (await login.json()) as { access_token: string };
    if (consent) {
      const granted = await this.#call('/me/consents', { type: 'goal_content', version: '2026-10-01' }, token);
      if (granted.status !== 201) throw new Error(`consent answered ${String(granted.status)}`);
    }
    return { email, token };
  }
}

async function loadTest(stack: Stack, data: string, reports: string): Promise<number> {
  const load: Account[] = [];
  for (let user = 0; user < LOAD_USERS; user += 1) load.push(await stack.account('load', true));
  const accounts = {
    load,
    burst: await stack.account('burst'),
    backoff: await stack.account('backoff'),
    targetDate: zurichDate(new Date(Date.now() + 30 * DAY_MS)),
  };
  writeFileSync(join(data, 'accounts.json'), JSON.stringify(accounts));
  mkdirSync(join(reports, 'k6'), { recursive: true });
  return tool(
    ['-e', 'BASE_URL=http://api:3000', '-v', `${resolve('test/perf')}:/scripts:ro`, '-v', `${data}:/data`],
    K6_IMAGE,
    ['run', '--quiet', '--summary-export', '/data/summary.json', '/scripts/limits.js'],
  ).finally(() => {
    const summary = join(data, 'summary.json');
    if (existsSync(summary)) copyFileSync(summary, join(reports, 'k6', 'summary.json'));
  });
}

interface ZapReport {
  readonly site: { readonly alerts: { readonly name: string; readonly riskcode: string; readonly count: string }[] }[];
}

async function dast(stack: Stack, data: string, reports: string): Promise<number> {
  const { token } = await stack.account('dast', true);
  // The contract names a placeholder server; the scan addresses the stack's API inside the network.
  const contract = readFileSync('openapi/openapi.yaml', 'utf8').replace(
    'https://api.example.invalid/v1',
    'http://api:3000/v1',
  );
  writeFileSync(join(data, 'openapi.yaml'), contract);
  copyFileSync('test/perf/zap-rules.tsv', join(data, 'zap-rules.tsv'));
  const bearer = [
    'replacer.full_list(0).description=bearer',
    'replacer.full_list(0).enabled=true',
    'replacer.full_list(0).matchtype=REQ_HEADER',
    'replacer.full_list(0).matchstr=Authorization',
    'replacer.full_list(0).regex=false',
    `replacer.full_list(0).replacement=Bearer ${token}`,
  ].map((setting) => `-config ${setting}`);
  const code = await tool(['-v', `${data}:/zap/wrk:rw`], ZAP_IMAGE, [
    ...['zap-api-scan.py', '-t', '/zap/wrk/openapi.yaml', '-f', 'openapi', '-S', '-I'],
    ...['-c', 'zap-rules.tsv', '-r', 'zap.html', '-J', 'zap.json', '-z', bearer.join(' ')],
  ]);
  mkdirSync(join(reports, 'zap'), { recursive: true });
  for (const file of ['zap.html', 'zap.json']) copyFileSync(join(data, file), join(reports, 'zap', file));
  const report = JSON.parse(readFileSync(join(data, 'zap.json'), 'utf8')) as ZapReport;
  const alerts = report.site.flatMap((site) => site.alerts);
  for (const alert of alerts) process.stdout.write(`ZAP risk ${alert.riskcode}: ${alert.name} (${alert.count})\n`);
  const high = alerts.filter((alert) => alert.riskcode === ZAP_HIGH).length;
  process.stdout.write(`ZAP: ${String(alerts.length)} alert types, ${String(high)} high\n`);
  return code === 0 && high === 0 ? 0 : 1;
}

async function main(mode: string | undefined): Promise<number> {
  if (mode !== 'k6' && mode !== 'zap') throw new Error('usage: node test/perf/run.ts k6|zap');
  const data = mkdtempSync(join(tmpdir(), 'questline-perf-'));
  // The tools run as their own users (ZAP 1000, k6 12345): on Linux they must be able to enter and write it.
  chmodSync(data, 0o777);
  const reports = resolve('reports');
  const stack = await Stack.create();
  try {
    await stack.start();
    return await (mode === 'k6' ? loadTest(stack, data, reports) : dast(stack, data, reports));
  } finally {
    await stack.stop();
    rmSync(data, { recursive: true, force: true });
  }
}

process.exitCode = await main(process.argv[2]);
