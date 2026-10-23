import { describe, expect, it } from 'vitest';
import { createLogger } from './logger.ts';

function capture() {
  const lines: string[] = [];
  const stream = { write: (line: string) => lines.push(line) };
  const records = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
  return { lines, stream, records };
}

describe('createLogger [R-LOG-01, R-LOG-02]', () => {
  it('writes JSON lines with ISO time, level label and service, without pid or hostname', () => {
    const { stream, records } = capture();
    createLogger({ service: 'questline-api', level: 'info' }, stream).info('hello');

    const [record] = records();
    expect(record).toEqual({
      level: 'info',
      time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) as unknown,
      service: 'questline-api',
      msg: 'hello',
    });
  });

  it('keeps only the name and code of errors, never message or stack [I-02]', () => {
    const { stream, records, lines } = capture();
    const error = Object.assign(new Error('SELECT secret FROM users'), {
      code: 'E_TEST',
      detail: 'alice@example.test',
    });
    createLogger({ service: 'questline-api', level: 'info' }, stream).error({ err: error }, 'failed');

    expect(records()[0]?.['err']).toEqual({ name: 'Error', code: 'E_TEST' });
    expect(lines.join('')).not.toMatch(/SELECT|alice@example|at .+\.ts/);
  });

  it.each([
    ['a thrown string', 'raw string with alice@example.test'],
    ['an object without a string name', { name: 42, message: 'alice@example.test' }],
    ['null', null],
  ])('logs %s as an unknown error without its content', (_label, thrown) => {
    const { stream, records, lines } = capture();
    createLogger({ service: 'questline-api', level: 'info' }, stream).error({ err: thrown }, 'failed');

    expect(records()[0]?.['err']).toEqual({ name: 'UnknownError' });
    expect(lines.join('')).not.toContain('alice@example.test');
  });

  it('redacts sensitive keys at the top level and one level deep', () => {
    const { stream, lines } = capture();
    createLogger({ service: 'questline-api', level: 'info' }, stream).info(
      {
        password: 'TopLevelPass1',
        token: 'TopLevelToken1',
        email: 'top@example.test',
        authorization: 'Bearer TopLevelAuth1',
        cookie: 'sid=TopLevelCookie1',
        headers: { 'x-anything': 'HeaderValue1' },
        body: { note: 'BodyValue1' },
        nested: { password: 'NestedPass1', token: 'NestedToken1', email: 'nested@example.test' },
      },
      'sensitive',
    );

    const text = lines.join('');
    for (const value of [
      'TopLevelPass1',
      'TopLevelToken1',
      'top@example.test',
      'TopLevelAuth1',
      'TopLevelCookie1',
      'HeaderValue1',
      'BodyValue1',
      'NestedPass1',
      'NestedToken1',
      'nested@example.test',
    ]) {
      expect(text).not.toContain(value);
    }
    expect(text).toContain('[redacted]');
  });

  it('respects the configured level', () => {
    const { stream, lines } = capture();
    const logger = createLogger({ service: 'questline-worker', level: 'warn' }, stream);
    logger.info('dropped');
    logger.warn('kept');

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"service":"questline-worker"');
  });

  it("drops Fastify's per-address listening announcements, which carry internal IP addresses [Q-28]", () => {
    const { stream, records } = capture();
    const logger = createLogger({ service: 'questline-api', level: 'info' }, stream);
    logger.info('Server listening at http://172.18.0.4:3000');
    logger.info('Server listening at http://[::1]:3000');
    logger.info({ port: 3000 }, 'api listening');
    logger.info('Server listening is the subject of this unrelated message');

    expect(records().map((record) => record['msg'])).toEqual([
      'api listening',
      'Server listening is the subject of this unrelated message',
    ]);
  });
});
