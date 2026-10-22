import type { FastifyInstance } from 'fastify';

/** One allowlisted line per request: route pattern instead of URL, no headers, bodies or query strings. */
export function registerRequestLogging(app: FastifyInstance): void {
  app.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        method: request.method,
        route: request.routeOptions.url ?? null,
        status: reply.statusCode,
        duration_ms: Math.round(reply.elapsedTime),
      },
      'request completed',
    );
  });
}
