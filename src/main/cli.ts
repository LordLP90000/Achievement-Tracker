import { ConfigError } from '../platform/config/config.ts';

/**
 * Runs a process entrypoint and returns its exit code. Failures are reported without values or causes:
 * configuration errors list variable names and rules, anything else only the error name.
 */
export async function runCli(task: () => Promise<void>, report: (line: string) => void): Promise<number> {
  try {
    await task();
    return 0;
  } catch (error) {
    if (error instanceof ConfigError) {
      report(error.message);
    } else {
      report(`Startup failed (${error instanceof Error ? error.name : 'UnknownError'}).`);
    }
    return 1;
  }
}
