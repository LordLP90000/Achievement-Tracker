import { z } from 'zod';
import { Problems, type ProblemDefinition, type ProblemFieldError } from './problem.ts';

/** At most this many field errors per response (`ValidationProblem.errors.maxItems` in the contract). */
const MAX_ERRORS = 50;
const MAX_MESSAGE_LENGTH = 200;

/** Raised anywhere in request handling to answer with an RFC 9457 problem (ADR-0007). */
export class ProblemError extends Error {
  override readonly name = 'ProblemError';
  readonly problem: ProblemDefinition;

  constructor(problem: ProblemDefinition) {
    super(problem.slug);
    this.problem = problem;
  }
}

/** RFC 6901 JSON pointer. Segments come from the schema's own keys, never from submitted property names. */
function pointerOf(path: readonly PropertyKey[]): string {
  return path.map((segment) => `/${String(segment).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
}

/** Static messages: Zod's own messages may contain submitted property names, so they are never used. */
function messageOf(issue: z.core.$ZodIssue): string {
  const missing = issue.input === undefined && (issue.code === 'invalid_type' || issue.code === 'invalid_value');
  if (missing) return 'is required';
  switch (issue.code) {
    case 'invalid_type':
      return 'has the wrong type';
    case 'too_small':
      return { array: 'has too few items', string: 'is too short' }[String(issue.origin)] ?? 'is too small';
    case 'too_big':
      return { array: 'has too many items', string: 'is too long' }[String(issue.origin)] ?? 'is too large';
    case 'invalid_format':
      return 'has an invalid format';
    case 'invalid_value':
      return 'is not one of the allowed values';
    case 'unrecognized_keys':
      return 'has a property that is not allowed';
    case 'custom':
      // Only refinements written in this code base produce custom issues, each with a static message.
      return issue.message.slice(0, MAX_MESSAGE_LENGTH);
    default:
      return 'is invalid';
  }
}

/** Validates a request body or query; failures become a 400 ValidationProblem that echoes nothing [R-IN-01]. */
export function parseRequest<T>(schema: z.ZodType<T>, value: unknown): T {
  // reportInput only lets messageOf tell "missing" from "wrong"; the inputs are never serialised.
  const result = schema.safeParse(value, { reportInput: true });
  if (result.success) return result.data;
  const errors: ProblemFieldError[] = result.error.issues
    .slice(0, MAX_ERRORS)
    .map((issue) => ({ pointer: pointerOf(issue.path), message: messageOf(issue) }));
  throw new ProblemError({ ...Problems.validation, errors });
}

/**
 * A string of `min`–`max` Unicode code points, as JSON Schema's `minLength`/`maxLength` count them; Zod's own length
 * checks count UTF-16 code units, which would refuse 64 emoji where the contract allows 64 characters.
 */
export function boundedText(min: number, max: number) {
  return z.string().superRefine((value, ctx) => {
    // More than twice `max` code units is more than `max` code points: no need to count them all.
    const length = value.length > 2 * max ? Number.POSITIVE_INFINITY : Array.from(value).length;
    if (length < min) ctx.addIssue({ code: 'custom', message: 'is too short' });
    if (length > max) ctx.addIssue({ code: 'custom', message: 'is too long' });
  });
}

const UUID_V4 = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

/** IDs are lower-case random UUID v4 (contract `Uuid`); anything else cannot name a resource. */
export function isUuidV4(value: string): boolean {
  return UUID_V4.test(value);
}
