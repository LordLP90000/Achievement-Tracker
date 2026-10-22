import type { Logger } from 'pino';
import type { WorkerConfig } from '../platform/config/config.ts';
import { createDatabaseClient, databaseReadiness } from '../platform/db/client.ts';
import type { Stoppable } from './shutdown.ts';

const SCHEDULER_TICK_MS = 60_000;

/**
 * Starts the background worker with the `questline_worker` database role. It has no jobs yet (retention,
 * outbox and settlement arrive in M2–M4); the scheduler tick keeps the process alive until then.
 */
export async function startWorker(config: WorkerConfig, logger: Logger): Promise<Stoppable> {
  const database = createDatabaseClient({
    url: config.databaseUrl,
    applicationName: 'questline-worker',
    maxConnections: 2,
  });
  try {
    await databaseReadiness(database)();
  } catch (error) {
    await database.close();
    throw error;
  }

  const tick = setInterval(() => undefined, SCHEDULER_TICK_MS);
  logger.info('worker ready');
  return {
    stop: async () => {
      clearInterval(tick);
      await database.close();
    },
  };
}
