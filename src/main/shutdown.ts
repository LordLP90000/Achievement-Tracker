import type { Logger } from 'pino';

export interface Stoppable {
  readonly stop: () => Promise<void>;
}

/** The parts of `process` used for shutdown, injectable for tests. */
export interface ShutdownHost {
  once(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown;
  exit(code: number): void;
}

export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

/**
 * Stops the service once on the first SIGTERM or SIGINT (in-flight requests finish, pools close, the event loop
 * drains). A failing or hanging stop forces exit code 1 so the orchestrator can restart cleanly.
 */
export function stopOnSignals(
  host: ShutdownHost,
  service: Stoppable,
  logger: Logger,
  options: { readonly timeoutMs?: number } = {},
): void {
  let stopping = false;

  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    const timer = setTimeout(() => {
      logger.error('shutdown timed out');
      host.exit(1);
    }, options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS);
    timer.unref();

    service.stop().then(
      () => {
        clearTimeout(timer);
        logger.info('stopped');
      },
      (error: unknown) => {
        clearTimeout(timer);
        logger.error({ err: error }, 'shutdown failed');
        host.exit(1);
      },
    );
  };

  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    host.once(signal, () => {
      shutdown(signal);
    });
  }
}
