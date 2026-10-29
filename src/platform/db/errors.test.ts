import { describe, expect, it } from 'vitest';
import { isUniqueViolation } from './errors.ts';

describe('isUniqueViolation', () => {
  it('recognises PostgreSQL error 23505 directly and wrapped in a query error (Drizzle)', () => {
    const pg = Object.assign(new Error('duplicate key'), { code: '23505' });

    expect(isUniqueViolation(pg)).toBe(true);
    expect(isUniqueViolation(new Error('Failed query', { cause: pg }))).toBe(true);
  });

  it.each([
    ['another PostgreSQL error', Object.assign(new Error('check'), { code: '23514' })],
    ['a wrapped other error', new Error('Failed query', { cause: Object.assign(new Error('fk'), { code: '23503' }) })],
    ['a plain error', new Error('boom')],
    ['a string', '23505'],
    ['null', null],
  ])('rejects %s', (_name, error) => {
    expect(isUniqueViolation(error)).toBe(false);
  });
});
