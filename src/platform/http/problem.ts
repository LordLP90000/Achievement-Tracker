import type { FastifyReply, FastifyRequest } from 'fastify';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json; charset=utf-8';
const MAX_INSTANCE_LENGTH = 300;

export interface ProblemFieldError {
  readonly pointer: string;
  readonly message: string;
}

/** A problem type of ADR-0007: static title, never any detail derived from user input or internals. */
export interface ProblemDefinition {
  readonly status: number;
  readonly slug: string;
  readonly title: string;
  readonly errors?: readonly ProblemFieldError[];
  /** Sent as `Retry-After` (whole seconds, ≥ 1), required on every `429` by the contract. */
  readonly retryAfterSeconds?: number;
  /** Further fixed response headers, e.g. `WWW-Authenticate` on a 401. */
  readonly headers?: Readonly<Record<string, string>>;
}

export const Problems = {
  invalidBody: {
    status: 400,
    slug: 'validation',
    title: 'Request validation failed',
    errors: [{ pointer: '', message: 'The request body is not valid JSON.' }],
  },
  validation: { status: 400, slug: 'validation', title: 'Request validation failed' },
  invalidCredentials: { status: 401, slug: 'invalid-credentials', title: 'Invalid email or password' },
  invalidToken: { status: 401, slug: 'invalid-token', title: 'Invalid or expired token' },
  /** Missing, expired or revoked access token (contract `Unauthorized`). */
  unauthorized: { status: 401, slug: 'unauthorized', title: 'Unauthorized', headers: { 'www-authenticate': 'Bearer' } },
  emailNotVerified: { status: 403, slug: 'email-not-verified', title: 'Email address not verified' },
  notFound: { status: 404, slug: 'not-found', title: 'Not Found' },
  payloadTooLarge: { status: 413, slug: 'payload-too-large', title: 'Payload Too Large' },
  unsupportedMediaType: { status: 415, slug: 'unsupported-media-type', title: 'Unsupported Media Type' },
  weakPassword: { status: 422, slug: 'weak-password', title: 'Password is too easy to guess' },
  /** Password hashing is saturated (D-01): the client retries shortly instead of the server queueing forever. */
  busy: { status: 429, slug: 'rate-limited', title: 'Too Many Requests', retryAfterSeconds: 1 },
  internal: { status: 500, slug: 'internal', title: 'Internal Server Error' },
} as const satisfies Record<string, ProblemDefinition>;

function instanceOf(url: string): string {
  const queryStart = url.indexOf('?');
  const path = queryStart === -1 ? url : url.slice(0, queryStart);
  return path.slice(0, MAX_INSTANCE_LENGTH);
}

export function sendProblem(request: FastifyRequest, reply: FastifyReply, problem: ProblemDefinition): FastifyReply {
  if (problem.retryAfterSeconds !== undefined) void reply.header('retry-after', String(problem.retryAfterSeconds));
  if (problem.headers !== undefined) void reply.headers(problem.headers);
  return reply
    .code(problem.status)
    .type(PROBLEM_CONTENT_TYPE)
    .send({
      type: `urn:questline:problem:${problem.slug}`,
      title: problem.title,
      status: problem.status,
      instance: instanceOf(request.url),
      request_id: request.id,
      ...(problem.errors === undefined ? {} : { errors: problem.errors }),
    });
}
