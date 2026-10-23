import { pino, type DestinationStream, type LogFn, type Logger } from 'pino';
import type { LogLevel } from '../config/config.ts';

export type ServiceName = 'questline-api' | 'questline-worker' | 'questline-migrate' | 'questline-db-init';

export interface LoggerSettings {
  readonly service: ServiceName;
  readonly level: LogLevel;
}

/** Second line of defence (R-LOG-02): the primary control is never passing such data to the logger at all. */
const REDACTED_KEYS = ['password', 'token', 'email', 'authorization', 'cookie', 'headers', 'body'];

/** Errors are logged by name and code only: messages and stacks can carry user input, SQL or paths. */
function serializeError(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null) return { name: 'UnknownError' };
  const { name, code } = value as { name?: unknown; code?: unknown };
  return { name: typeof name === 'string' ? name : 'UnknownError', ...(typeof code === 'string' ? { code } : {}) };
}

/**
 * Fastify announces every interface address it listens on ("Server listening at http://172.18.0.4:3000") and has
 * no switch to turn that off; the API logs one structured `api listening` line with the port instead (Q-28).
 */
const FASTIFY_LISTENING_ANNOUNCEMENT = /^Server listening at \S+$/;

function dropListeningAnnouncements(this: Logger, args: Parameters<LogFn>, method: LogFn): void {
  const [first] = args as unknown[];
  if (typeof first === 'string' && FASTIFY_LISTENING_ANNOUNCEMENT.test(first)) return;
  method.apply(this, args);
}

export function createLogger(settings: LoggerSettings, destination?: DestinationStream): Logger {
  const options = {
    level: settings.level,
    base: { service: settings.service },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label: string) => ({ level: label }) },
    serializers: { err: serializeError },
    redact: { paths: REDACTED_KEYS.flatMap((key) => [key, `*.${key}`]), censor: '[redacted]' },
    hooks: { logMethod: dropListeningAnnouncements },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}
