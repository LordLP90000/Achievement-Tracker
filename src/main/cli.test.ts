import { describe, expect, it } from 'vitest';
import { ConfigError } from '../platform/config/config.ts';
import { runCli } from './cli.ts';

describe('runCli', () => {
  const run = async (task: () => Promise<void>) => {
    const lines: string[] = [];
    const code = await runCli(task, (line) => lines.push(line));
    return { code, lines };
  };

  it('returns exit code 0 when the task succeeds', async () => {
    expect(await run(() => Promise.resolve())).toEqual({ code: 0, lines: [] });
  });

  it('reports configuration issues without values and returns exit code 1 [E-08]', async () => {
    const result = await run(() => Promise.reject(new ConfigError(['DATABASE_URL_APP: is required'])));

    expect(result).toEqual({ code: 1, lines: ['Invalid configuration:\n- DATABASE_URL_APP: is required'] });
  });

  it('reports any other failure by error name only and returns exit code 1', async () => {
    const result = await run(() => Promise.reject(new TypeError('connect to postgres://u:SecretPass@db failed')));

    expect(result).toEqual({ code: 1, lines: ['Startup failed (TypeError).'] });
  });

  it('never reports the cause of a failure', async () => {
    const result = await run(() => Promise.reject(new Error('x', { cause: 'SecretPass' })));

    expect(result).toEqual({ code: 1, lines: ['Startup failed (Error).'] });
  });
});
