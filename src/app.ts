import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { registerErrorHandling } from './platform/http/errors.ts';
import { registerSecurityHeaders } from './platform/http/security-headers.ts';

export const BODY_LIMIT_BYTES = 64 * 1024;

export interface AppDependencies {
  readonly http: { readonly trustProxyHops: number };
  readonly logger: FastifyBaseLogger;
}

/** Builds the API without starting it; callers add nothing but tests may register `/__test/*` routes. */
export function buildApp(deps: AppDependencies): FastifyInstance {
  const app = Fastify({
    loggerInstance: deps.logger,
    logController: new LogController({ disableRequestLogging: true, requestIdLogLabel: 'request_id' }),
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    trustProxy: (_address: string, hop: number) => hop < deps.http.trustProxyHops,
    bodyLimit: BODY_LIMIT_BYTES,
    onProtoPoisoning: 'error',
    onConstructorPoisoning: 'error',
    exposeHeadRoutes: false,
    return503OnClosing: true,
  });

  app.removeContentTypeParser('text/plain');
  registerSecurityHeaders(app);
  registerErrorHandling(app);
  return app;
}
