import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { accountsRoutes } from './modules/accounts/routes.ts';
import type { AccountsService } from './modules/accounts/service.ts';
import { healthRoutes, type ReadinessProbe } from './modules/health/routes.ts';
import { registerAuthGuard } from './modules/sessions/guard.ts';
import { sessionsRoutes } from './modules/sessions/routes.ts';
import type { SessionsService } from './modules/sessions/service.ts';
import { registerErrorHandling } from './platform/http/errors.ts';
import { registerRequestLogging } from './platform/http/request-logging.ts';
import { registerSecurityHeaders } from './platform/http/security-headers.ts';

export const BODY_LIMIT_BYTES = 64 * 1024;
export const DEFAULT_READINESS_TIMEOUT_MS = 2000;
/** Base path of the versioned API (`servers` in the contract); health probes live outside it. */
export const API_PREFIX = '/v1';

export interface AppServices {
  readonly accounts: AccountsService;
  readonly sessions: SessionsService;
}

export interface AppDependencies {
  readonly http: { readonly trustProxyHops: number };
  readonly logger: FastifyBaseLogger;
  readonly readiness: ReadinessProbe;
  readonly readinessTimeoutMs?: number;
  readonly services: AppServices;
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
  registerRequestLogging(app);
  registerErrorHandling(app);
  void app.register(healthRoutes, {
    readiness: deps.readiness,
    readinessTimeoutMs: deps.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS,
  });
  void app.register(
    (v1, _options, done) => {
      // Deny by default: every /v1 route needs an access token unless it is public in the contract (R-AUTHZ-01).
      registerAuthGuard(v1, deps.services.sessions);
      void v1.register(accountsRoutes, { accounts: deps.services.accounts });
      void v1.register(sessionsRoutes, { sessions: deps.services.sessions });
      done();
    },
    { prefix: API_PREFIX },
  );
  return app;
}
