import { describe, expect, it } from 'vitest';
import { jobErrorCode } from './scheduler.ts';

describe('jobErrorCode', () => {
  it('names a PostgreSQL error by its SQLSTATE', () => {
    expect(
      jobErrorCode(Object.assign(new Error('canceling statement'), { name: 'PostgresError', code: '57014' })),
    ).toBe('pg_57014');
  });

  it('names any other error by its class, never by its message', () => {
    expect(jobErrorCode(new TypeError('ada@example.test is not a function'))).toBe('typeerror');
    expect(jobErrorCode(Object.assign(new Error('x'), { name: 'PostgresError', code: 'not a state' }))).toBe(
      'postgreserror',
    );
  });

  it('falls back to unknown for anything without a usable name', () => {
    for (const odd of [
      undefined,
      null,
      'boom',
      42,
      {},
      { name: 'has spaces' },
      { name: 'x'.repeat(41) },
      { name: '' },
    ]) {
      expect(jobErrorCode(odd)).toBe('unknown');
    }
    expect(jobErrorCode({ name: 'x'.repeat(40) })).toBe('x'.repeat(40));
  });
});
