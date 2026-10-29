import type { AddressInfo } from 'node:net';
import type { Logger } from 'pino';
import { buildApp } from '../app.ts';
import { loadBreachedPasswordFilter } from '../modules/accounts/password-policy.ts';
import { createEmailChangeService } from '../modules/accounts/email-change-service.ts';
import { createPasswordsService } from '../modules/accounts/password-service.ts';
import { createProfileService } from '../modules/accounts/profile-service.ts';
import { createAccountsService } from '../modules/accounts/service.ts';
import { createSessionsService } from '../modules/sessions/service.ts';
import type { ApiConfig } from '../platform/config/config.ts';
import { createDataKeys } from '../platform/crypto/data-keys.ts';
import type { Kek } from '../platform/crypto/kek-source.ts';
import { localKeyWrapper } from '../platform/crypto/key-wrapper.ts';
import { createArgon2idHasher } from '../platform/crypto/password.ts';
import { createDatabaseClient, databaseReadiness } from '../platform/db/client.ts';
import { createDatabase } from '../platform/db/database.ts';
import { systemClock } from '../platform/time/clock.ts';
import type { Stoppable } from './shutdown.ts';

export interface RunningApi extends Stoppable {
  readonly url: string;
}

/** Keys the API needs at runtime; the KEK was fetched from its source before the API starts (R-ENC-05). */
export interface ApiKeyMaterial {
  readonly kek: Kek;
  readonly blindIndexKey: Uint8Array;
}

/**
 * Argon2id runs on libuv's thread pool (4 threads by default), which also serves DNS lookups and file I/O: two
 * hashes at a time leave room for both; a short queue absorbs bursts, anything beyond is refused with 429 (D-01).
 * To be tuned with the M6 load test on the chosen hosting (O-01).
 */
export const PASSWORD_HASHING = Object.freeze({ maxConcurrent: 2, maxQueued: 32 });

/** Starts the API with the `questline_app` database role; readiness follows the database. */
export async function startApi(config: ApiConfig, keys: ApiKeyMaterial, logger: Logger): Promise<RunningApi> {
  const hasher = await createArgon2idHasher(PASSWORD_HASHING);
  const breachedPasswords = loadBreachedPasswordFilter();
  const database = createDatabaseClient({ url: config.databaseUrl, applicationName: 'questline-api' });
  const shared = {
    db: createDatabase(database),
    clock: systemClock,
    hasher,
    blindIndexKey: keys.blindIndexKey,
    dataKeys: createDataKeys(localKeyWrapper(keys.kek)),
  };
  const services = {
    accounts: createAccountsService({ ...shared, breachedPasswords }),
    passwords: createPasswordsService({ ...shared, breachedPasswords }),
    emailChanges: createEmailChangeService(shared),
    profiles: createProfileService(shared),
    sessions: createSessionsService(shared),
  };
  const app = buildApp({ http: config.http, logger, readiness: databaseReadiness(database), services });
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
