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
}

export const Problems = {
  invalidBody: {
    status: 400,
    slug: 'validation',
    title: 'Request validation failed',
    errors: [{ pointer: '', message: 'The request body is not valid JSON.' }],
  },
  validation: { status: 400, slug: 'validation', title: 'Request validation failed' },
  notFound: { status: 404, slug: 'not-found', title: 'Not Found' },
  payloadTooLarge: { status: 413, slug: 'payload-too-large', title: 'Payload Too Large' },
  unsupportedMediaType: { status: 415, slug: 'unsupported-media-type', title: 'Unsupported Media Type' },
  internal: { status: 500, slug: 'internal', title: 'Internal Server Error' },
} as const satisfies Record<string, ProblemDefinition>;

function instanceOf(url: string): string {
  const queryStart = url.indexOf('?');
  const path = queryStart === -1 ? url : url.slice(0, queryStart);
  return path.slice(0, MAX_INSTANCE_LENGTH);
}

export function sendProblem(request: FastifyRequest, reply: FastifyReply, problem: ProblemDefinition): FastifyReply {
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
