import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Set on high-frequency probe routes: successful responses are not logged, failures still are (Q-28). */
    readonly quietOnSuccess?: boolean;
  }
}

/** One allowlisted line per request: route pattern instead of URL, no headers, bodies or query strings. */
export function registerRequestLogging(app: FastifyInstance): void {
  app.addHook('onResponse', async (request, reply) => {
    // Unmatched routes always end with an error status, so routes without config never reach the second check.
    if (reply.statusCode < 400 && request.routeOptions.config.quietOnSuccess === true) return;
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
