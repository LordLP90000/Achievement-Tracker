import type { FastifyBaseLogger, FastifyPluginCallback } from 'fastify';

/** Resolves to true when every dependency needed to serve traffic is usable. */
export type ReadinessProbe = () => Promise<boolean>;

export interface HealthRoutesOptions {
  readonly readiness: ReadinessProbe;
  readonly readinessTimeoutMs: number;
}

async function isReady(probe: ReadinessProbe, timeoutMs: number, log: FastifyBaseLogger): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout');
    }, timeoutMs);
  });
  try {
    const result = await Promise.race([probe(), timedOut]);
    if (result === 'timeout') {
      log.warn('readiness check timed out');
      return false;
    }
    if (!result) log.warn('readiness check reported not ready');
    return result;
  } catch (error) {
    log.warn({ err: error }, 'readiness check failed');
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Health probes outside `/v1`, unauthenticated, disclosing nothing but a status (A-18, I-15). */
export const healthRoutes: FastifyPluginCallback<HealthRoutesOptions> = (app, options, done) => {
  // Probed every few seconds by Docker or a load balancer: only failures are logged (Q-28).
  const probe = { config: { quietOnSuccess: true } };

  app.get('/health/live', probe, () => ({ status: 'ok' }));

  app.get('/health/ready', probe, async (request, reply) => {
    const ready = await isReady(options.readiness, options.readinessTimeoutMs, request.log);
    return reply.code(ready ? 200 : 503).send({ status: ready ? 'ok' : 'degraded' });
  });

  done();
};
