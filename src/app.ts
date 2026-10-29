import { randomUUID } from 'node:crypto';
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { emailChangeRoutes } from './modules/accounts/email-change-routes.ts';
import type { EmailChangeService } from './modules/accounts/email-change-service.ts';
import { passwordRoutes } from './modules/accounts/password-routes.ts';
import { profileRoutes } from './modules/accounts/profile-routes.ts';
import type { ProfileService } from './modules/accounts/profile-service.ts';
import type { PasswordsService } from './modules/accounts/password-service.ts';
import { accountsRoutes } from './modules/accounts/routes.ts';
import type { AccountsService } from './modules/accounts/service.ts';
import { consentsRoutes } from './modules/consents/routes.ts';
import type { ConsentsService } from './modules/consents/service.ts';
import { healthRoutes, type ReadinessProbe } from './modules/health/routes.ts';
import { registerRequestLimits } from './modules/rate-limit/http.ts';
import type { RateLimiter } from './modules/rate-limit/limiter.ts';
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
  readonly consents: ConsentsService;
  readonly emailChanges: EmailChangeService;
  readonly passwords: PasswordsService;
  readonly profiles: ProfileService;
  readonly rateLimiter: RateLimiter;
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
      // After the guard: per client network on public routes, per user on authenticated ones (R-AUTH-08).
      const limiter = deps.services.rateLimiter;
      registerRequestLimits(v1, limiter);
      void v1.register(accountsRoutes, { accounts: deps.services.accounts, limiter });
      void v1.register(passwordRoutes, { passwords: deps.services.passwords, limiter });
      void v1.register(emailChangeRoutes, { emailChanges: deps.services.emailChanges, limiter });
      void v1.register(profileRoutes, { profiles: deps.services.profiles });
      void v1.register(consentsRoutes, { consents: deps.services.consents });
      void v1.register(sessionsRoutes, { sessions: deps.services.sessions, limiter });
      done();
    },
    { prefix: API_PREFIX },
  );
  return app;
}
