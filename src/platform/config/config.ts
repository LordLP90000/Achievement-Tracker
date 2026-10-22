import { z } from 'zod';

export const APP_ENVS = ['development', 'test', 'production'] as const;
export const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

export type AppEnv = (typeof APP_ENVS)[number];
export type LogLevel = (typeof LOG_LEVELS)[number];
export type Env = Readonly<Record<string, string | undefined>>;

export interface HttpConfig {
  readonly host: string;
  readonly port: number;
  readonly trustProxyHops: number;
}

export interface ApiConfig {
  readonly appEnv: AppEnv;
  readonly logLevel: LogLevel;
  readonly http: HttpConfig;
  readonly databaseUrl: string;
}

export interface ProcessConfig {
  readonly appEnv: AppEnv;
  readonly logLevel: LogLevel;
  readonly databaseUrl: string;
}

export type WorkerConfig = ProcessConfig;
export type MigrateConfig = ProcessConfig;

export interface BootstrapConfig {
  readonly appEnv: AppEnv;
  readonly logLevel: LogLevel;
  readonly adminUrl: string;
  readonly database: string;
  readonly passwords: { readonly migrator: string; readonly app: string; readonly worker: string };
}

/** Raised when the environment is unusable. Issues name variables and rules, never the submitted values. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Invalid configuration:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
    this.issues = Object.freeze([...issues]);
  }
}

const URL_RULE = 'must be a postgres:// or postgresql:// URL';
const PORT_RULE = 'must be an integer between 1 and 65535';
const HOPS_RULE = 'must be an integer between 0 and 10';
const PLACEHOLDER_FRAGMENTS = ['change', 'example', 'placeholder', 'password', 'secret'];
const MIN_PRODUCTION_PASSWORD_LENGTH = 16;

const blankToUndefined = (value: unknown): unknown => (value === '' ? undefined : value);
const requiredOr =
  (rule: string) =>
  (issue: { input?: unknown }): string =>
    issue.input === undefined ? 'is required' : rule;

const appEnvSchema = z.preprocess(
  blankToUndefined,
  z.enum(APP_ENVS, { error: requiredOr(`must be one of ${APP_ENVS.join(', ')}`) }),
);
const logLevelSchema = z.preprocess(
  blankToUndefined,
  z.enum(LOG_LEVELS, { error: `must be one of ${LOG_LEVELS.join(', ')}` }).default('info'),
);
const hostSchema = z.preprocess(blankToUndefined, z.string().min(1).default('127.0.0.1'));
const portSchema = z.preprocess(
  blankToUndefined,
  z.coerce
    .number({ error: PORT_RULE })
    .int({ error: PORT_RULE })
    .min(1, { error: PORT_RULE })
    .max(65535, { error: PORT_RULE })
    .default(3000),
);
const trustProxyHopsSchema = z.preprocess(
  blankToUndefined,
  z.coerce
    .number({ error: HOPS_RULE })
    .int({ error: HOPS_RULE })
    .min(0, { error: HOPS_RULE })
    .max(10, { error: HOPS_RULE })
    .optional(),
);
const databaseUrlSchema = z.preprocess(
  blankToUndefined,
  z.string({ error: requiredOr(URL_RULE) }).refine(isPostgresUrl, { error: URL_RULE }),
);
const databaseNameSchema = z.preprocess(
  blankToUndefined,
  z
    .string()
    .regex(/^[a-z_][a-z\d_]{0,62}$/, { error: 'must be a lower-case PostgreSQL identifier' })
    .default('questline'),
);
const requiredSecretSchema = z.preprocess(blankToUndefined, z.string({ error: 'is required' }));

function isPostgresUrl(value: string): boolean {
  return URL.canParse(value) && ['postgres:', 'postgresql:'].includes(new URL(value).protocol);
}

function decode(component: string): string {
  try {
    return decodeURIComponent(component);
  } catch {
    return component;
  }
}

function isStrongPassword(password: string, user?: string): boolean {
  const lowered = password.toLowerCase();
  return (
    password.length >= MIN_PRODUCTION_PASSWORD_LENGTH &&
    new Set(password).size > 1 &&
    // nosemgrep: questline-timing-unsafe-secret-comparison -- one-off startup check of operator config, no oracle
    password !== user &&
    !PLACEHOLDER_FRAGMENTS.some((fragment) => lowered.includes(fragment))
  );
}

function productionDatabaseIssues(variable: string, value: string): string[] {
  const url = new URL(value);
  const issues: string[] = [];
  if (url.searchParams.get('sslmode') !== 'verify-full') {
    issues.push(`${variable}: must use sslmode=verify-full in production`);
  }
  if (!isStrongPassword(decode(url.password), decode(url.username))) {
    issues.push(`${variable}: password is missing or too weak for production`);
  }
  return issues;
}

function parseEnv<Shape extends z.ZodRawShape>(shape: Shape, env: Env): z.infer<z.ZodObject<Shape>> {
  const result = z.object(shape).safeParse(env);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((issue) => `${String(issue.path[0])}: ${issue.message}`));
  }
  return result.data;
}

function logLevelIssues(logLevel: LogLevel): string[] {
  return logLevel === 'debug' || logLevel === 'trace'
    ? ['LOG_LEVEL: debug and trace are not allowed in production']
    : [];
}

function assertNoIssues(issues: readonly string[]): void {
  if (issues.length > 0) throw new ConfigError(issues);
}

function processConfig(
  appEnv: AppEnv,
  logLevel: LogLevel,
  databaseVariable: string,
  databaseUrl: string,
): ProcessConfig {
  if (appEnv === 'production') {
    assertNoIssues([...logLevelIssues(logLevel), ...productionDatabaseIssues(databaseVariable, databaseUrl)]);
  }
  return Object.freeze({ appEnv, logLevel, databaseUrl });
}

export function loadApiConfig(env: Env): ApiConfig {
  const parsed = parseEnv(
    {
      APP_ENV: appEnvSchema,
      LOG_LEVEL: logLevelSchema,
      HOST: hostSchema,
      PORT: portSchema,
      TRUST_PROXY_HOPS: trustProxyHopsSchema,
      DATABASE_URL_APP: databaseUrlSchema,
    },
    env,
  );

  if (parsed.APP_ENV === 'production') {
    assertNoIssues([
      ...logLevelIssues(parsed.LOG_LEVEL),
      ...(parsed.TRUST_PROXY_HOPS === undefined ? ['TRUST_PROXY_HOPS: is required in production'] : []),
      ...productionDatabaseIssues('DATABASE_URL_APP', parsed.DATABASE_URL_APP),
    ]);
  }

  return Object.freeze({
    appEnv: parsed.APP_ENV,
    logLevel: parsed.LOG_LEVEL,
    http: Object.freeze({ host: parsed.HOST, port: parsed.PORT, trustProxyHops: parsed.TRUST_PROXY_HOPS ?? 0 }),
    databaseUrl: parsed.DATABASE_URL_APP,
  });
}

export function loadWorkerConfig(env: Env): WorkerConfig {
  const parsed = parseEnv(
    { APP_ENV: appEnvSchema, LOG_LEVEL: logLevelSchema, DATABASE_URL_WORKER: databaseUrlSchema },
    env,
  );
  return processConfig(parsed.APP_ENV, parsed.LOG_LEVEL, 'DATABASE_URL_WORKER', parsed.DATABASE_URL_WORKER);
}

export function loadMigrateConfig(env: Env): MigrateConfig {
  const parsed = parseEnv(
    { APP_ENV: appEnvSchema, LOG_LEVEL: logLevelSchema, DATABASE_URL_MIGRATOR: databaseUrlSchema },
    env,
  );
  return processConfig(parsed.APP_ENV, parsed.LOG_LEVEL, 'DATABASE_URL_MIGRATOR', parsed.DATABASE_URL_MIGRATOR);
}

function rolePasswordIssues(passwords: readonly (readonly [string, string])[]): string[] {
  return passwords.flatMap(([variable, password], index) => [
    ...(isStrongPassword(password) ? [] : [`${variable}: password is missing or too weak for production`]),
    // nosemgrep: questline-timing-unsafe-secret-comparison -- one-off startup check of operator config, no oracle
    ...(passwords.slice(0, index).some(([, earlier]) => earlier === password)
      ? [`${variable}: must differ from the other role passwords`]
      : []),
  ]);
}

/** Configuration of the one-off database bootstrap (Compose `db-init`, operations runbook). */
export function loadBootstrapConfig(env: Env): BootstrapConfig {
  const parsed = parseEnv(
    {
      APP_ENV: appEnvSchema,
      LOG_LEVEL: logLevelSchema,
      DATABASE_ADMIN_URL: databaseUrlSchema,
      DATABASE_NAME: databaseNameSchema,
      DB_PASSWORD_MIGRATOR: requiredSecretSchema,
      DB_PASSWORD_APP: requiredSecretSchema,
      DB_PASSWORD_WORKER: requiredSecretSchema,
    },
    env,
  );

  if (parsed.APP_ENV === 'production') {
    assertNoIssues([
      ...logLevelIssues(parsed.LOG_LEVEL),
      ...productionDatabaseIssues('DATABASE_ADMIN_URL', parsed.DATABASE_ADMIN_URL),
      ...rolePasswordIssues([
        ['DB_PASSWORD_MIGRATOR', parsed.DB_PASSWORD_MIGRATOR],
        ['DB_PASSWORD_APP', parsed.DB_PASSWORD_APP],
        ['DB_PASSWORD_WORKER', parsed.DB_PASSWORD_WORKER],
      ]),
    ]);
  }

  return Object.freeze({
    appEnv: parsed.APP_ENV,
    logLevel: parsed.LOG_LEVEL,
    adminUrl: parsed.DATABASE_ADMIN_URL,
    database: parsed.DATABASE_NAME,
    passwords: Object.freeze({
      migrator: parsed.DB_PASSWORD_MIGRATOR,
      app: parsed.DB_PASSWORD_APP,
      worker: parsed.DB_PASSWORD_WORKER,
    }),
  });
}
