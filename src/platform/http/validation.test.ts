import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Problems } from './problem.ts';
import { parseRequest, ProblemError } from './validation.ts';

const schema = z.strictObject({
  email: z.email().max(254),
  password: z.string().min(12).max(128),
  age: z.number().int().min(13).optional(),
  tags: z.array(z.string().max(3)).max(2).optional(),
  locale: z.enum(['de-CH', 'en']).optional(),
  accepted: z.literal(true),
  timezone: z
    .string()
    .refine((value) => value === 'Europe/Zurich', { message: 'must be a supported IANA time zone' })
    .optional(),
});

function problemOf(value: unknown): ProblemError {
  try {
    parseRequest(schema, value);
  } catch (error) {
    expect(error).toBeInstanceOf(ProblemError);
    return error as ProblemError;
  }
  throw new Error('expected a ProblemError');
}

const valid = { email: 'alice@example.test', password: 'correct horse battery', accepted: true };

describe('parseRequest (ADR-0007, ValidationProblem in the contract)', () => {
  it('returns the parsed value when it is valid', () => {
    expect(parseRequest(schema, valid)).toEqual(valid);
  });

  it('reports each invalid field with a JSON pointer and a static message', () => {
    const problem = problemOf({
      email: 'not-an-email',
      password: 'short',
      age: 12.5,
      tags: ['four'],
      locale: 'xx',
      accepted: false,
      timezone: 'Mars/Olympus',
    });

    expect(problem.problem).toMatchObject({ status: 400, slug: 'validation', title: 'Request validation failed' });
    expect(problem.problem.errors).toEqual([
      { pointer: '/email', message: 'has an invalid format' },
      { pointer: '/password', message: 'is too short' },
      { pointer: '/age', message: 'has the wrong type' },
      { pointer: '/tags/0', message: 'is too long' },
      { pointer: '/locale', message: 'is not one of the allowed values' },
      { pointer: '/accepted', message: 'is not one of the allowed values' },
      { pointer: '/timezone', message: 'must be a supported IANA time zone' },
    ]);
    expect(problemOf({ ...valid, tags: ['a', 'b', 'c'], age: 9 }).problem.errors).toEqual([
      { pointer: '/age', message: 'is too small' },
      { pointer: '/tags', message: 'has too many items' },
    ]);
    expect(problemOf({ ...valid, password: 'x'.repeat(129), age: 1e9 * 1e9 }).problem.errors).toEqual([
      { pointer: '/password', message: 'is too long' },
      { pointer: '/age', message: 'is too large' },
    ]);
  });

  it('names missing fields and a missing body', () => {
    expect(problemOf({}).problem.errors).toEqual([
      { pointer: '/email', message: 'is required' },
      { pointer: '/password', message: 'is required' },
      { pointer: '/accepted', message: 'is required' },
    ]);
    expect(problemOf(undefined).problem.errors).toEqual([{ pointer: '', message: 'is required' }]);
  });

  it('never echoes a submitted value or an unknown property name [I-02]', () => {
    const secret = 'Secret-Value-4711';
    const problem = problemOf({ ...valid, password: 42, email: `${secret}@`, [`${secret}-key`]: secret });
    const text = JSON.stringify(problem.problem);

    expect(text).not.toContain(secret);
    expect(problem.problem.errors).toContainEqual({ pointer: '', message: 'has a property that is not allowed' });
  });

  it('reports at most 50 errors', () => {
    const many = z.strictObject({ items: z.array(z.number()) });
    const problem = (() => {
      try {
        parseRequest(many, { items: Array.from({ length: 80 }, () => 'x') });
      } catch (error) {
        return error as ProblemError;
      }
      throw new Error('expected a ProblemError');
    })();

    expect(problem.problem.errors).toHaveLength(50);
  });

  it('carries a problem definition and names itself for the log', () => {
    const error = new ProblemError(Problems.notFound);

    expect(error.name).toBe('ProblemError');
    expect(error.problem).toBe(Problems.notFound);
    expect(error.message).toBe('not-found');
  });
});
