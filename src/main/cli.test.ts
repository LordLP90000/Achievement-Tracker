import { describe, expect, it } from 'vitest';
import { ConfigError } from '../platform/config/config.ts';
import { KekSourceError } from '../platform/crypto/kek-source.ts';
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

  it('reports a rejection that is not an Error without its value', async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- under test: libraries may reject with any value
    const result = await run(() => Promise.reject(new Map([['password', 'SecretPass']])));

    expect(result).toEqual({ code: 1, lines: ['Startup failed (UnknownError).'] });
  });

  it('adds the code of an error that carries one, e.g. why the KEK could not be loaded [E-11]', async () => {
    const result = await run(() => Promise.reject(new KekSourceError('connect_timeout')));

    expect(result).toEqual({ code: 1, lines: ['Startup failed (KekSourceError: connect_timeout).'] });
  });

  it.each([42, 'user=alice password=hunter2', 'x'.repeat(41)])(
    'leaves out a code that is not a short identifier: %j',
    async (code) => {
      const result = await run(() => Promise.reject(Object.assign(new Error('boom'), { code })));

      expect(result).toEqual({ code: 1, lines: ['Startup failed (Error).'] });
    },
  );
});
