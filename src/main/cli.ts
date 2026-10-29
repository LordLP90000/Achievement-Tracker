import { ConfigError } from '../platform/config/config.ts';

/** Error codes are reported only when they are short identifiers (`connect_timeout`, `ECONNREFUSED`, `28P01`). */
const SAFE_CODE = /^\w{1,40}$/;

function describeFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'UnknownError';
  const { code } = error as { code?: unknown };
  return typeof code === 'string' && SAFE_CODE.test(code) ? `${error.name}: ${code}` : error.name;
}

/**
 * Runs a process entrypoint and returns its exit code. Failures are reported without values or causes:
 * configuration errors list variable names and rules, anything else only the error name and its code.
 */
export async function runCli(task: () => Promise<void>, report: (line: string) => void): Promise<number> {
  try {
    await task();
    return 0;
  } catch (error) {
    report(error instanceof ConfigError ? error.message : `Startup failed (${describeFailure(error)}).`);
    return 1;
  }
}
