import type { AddressInfo } from 'node:net';
import type { Logger } from 'pino';
import { buildApp } from '../app.ts';
import type { ApiConfig } from '../platform/config/config.ts';
import { createDatabaseClient, databaseReadiness } from '../platform/db/client.ts';
import type { Stoppable } from './shutdown.ts';

export interface RunningApi extends Stoppable {
  readonly url: string;
}

/** Starts the API with the `questline_app` database role; readiness follows the database. */
export async function startApi(config: ApiConfig, logger: Logger): Promise<RunningApi> {
  const database = createDatabaseClient({ url: config.databaseUrl, applicationName: 'questline-api' });
  const app = buildApp({ http: config.http, logger, readiness: databaseReadiness(database) });
  try {
    const url = await app.listen({ host: config.http.host, port: config.http.port });
    logger.info({ port: (app.server.address() as AddressInfo).port }, 'api listening');
    return {
      url,
      stop: async () => {
        await app.close();
        await database.close();
      },
    };
  } catch (error) {
    await database.close();
    throw error;
  }
}
