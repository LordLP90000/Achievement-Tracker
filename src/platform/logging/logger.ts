import { pino, type DestinationStream, type Logger } from 'pino';
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

export function createLogger(settings: LoggerSettings, destination?: DestinationStream): Logger {
  const options = {
    level: settings.level,
    base: { service: settings.service },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label: string) => ({ level: label }) },
    serializers: { err: serializeError },
    redact: { paths: REDACTED_KEYS.flatMap((key) => [key, `*.${key}`]), censor: '[redacted]' },
  };
  return destination === undefined ? pino(options) : pino(options, destination);
}
