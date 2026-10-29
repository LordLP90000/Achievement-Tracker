import type { FastifyError, FastifyInstance } from 'fastify';
import { SemaphoreFullError } from '../crypto/semaphore.ts';
import { Problems, sendProblem, type ProblemDefinition } from './problem.ts';
import { ProblemError } from './validation.ts';

function problemFor(error: FastifyError): ProblemDefinition {
  switch (error.statusCode) {
    case 400:
      return Problems.invalidBody;
    case 413:
      return Problems.payloadTooLarge;
    case 415:
      return Problems.unsupportedMediaType;
    default:
      return Problems.internal;
  }
}

/** Every failure becomes an RFC 9457 problem; unknown errors become a generic 500 (ADR-0007). */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => sendProblem(request, reply, Problems.notFound));

  app.setErrorHandler((error: FastifyError, request, reply) => {
    if (error instanceof ProblemError) return sendProblem(request, reply, error.problem);
    if (error instanceof SemaphoreFullError) {
      request.log.warn('password hashing saturated');
      return sendProblem(request, reply, Problems.busy);
    }
    const problem = problemFor(error);
    if (problem.status >= 500) {
      request.log.error({ err: { name: error.name, code: error.code } }, 'request failed');
    }
    return sendProblem(request, reply, problem);
  });
}
