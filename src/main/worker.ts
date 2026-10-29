import type { Logger } from 'pino';
import type { WorkerConfig } from '../platform/config/config.ts';
import { createDataKeys } from '../platform/crypto/data-keys.ts';
import type { Kek } from '../platform/crypto/kek-source.ts';
import { localKeyWrapper } from '../platform/crypto/key-wrapper.ts';
import { createDatabaseClient, databaseReadiness } from '../platform/db/client.ts';
import { createDatabase } from '../platform/db/database.ts';
import { createOutboxDelivery } from '../platform/email/delivery.ts';
import type { EmailSender } from '../platform/email/sender.ts';
import { createSmtpEmailSender } from '../platform/email/smtp-sender.ts';
import { startPoller, type Poller } from '../platform/jobs/poller.ts';
import { systemClock, type Clock } from '../platform/time/clock.ts';
import type { Stoppable } from './shutdown.ts';

/** How often the worker looks for due emails: a verification email leaves within seconds of the request. */
export const OUTBOX_POLL_MS = 5_000;
const KEEP_ALIVE_MS = 60_000;

/** The worker decrypts queued email payloads with user data keys, so it needs the KEK (R-ENC-05). */
export interface WorkerKeyMaterial {
  readonly kek: Kek;
}

/** Replaceable parts for tests; production sends through the configured SMTP relay with the system clock. */
export interface WorkerOverrides {
  readonly emailSender?: EmailSender;
  readonly clock?: Clock;
  readonly pollIntervalMs?: number;
}

/**
 * Starts the background worker with the `questline_worker` database role: it drains the email outbox (ADR-0009,
 * ADR-0014). Retention and settlement jobs follow (M2–M4).
 */
export async function startWorker(
  config: WorkerConfig,
  keys: WorkerKeyMaterial,
  logger: Logger,
  overrides: WorkerOverrides = {},
): Promise<Stoppable> {
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

  // Keeps the process alive even when no job runs (development without SMTP settings).
  const keepAlive = setInterval(() => undefined, KEEP_ALIVE_MS);
  const { email } = config;
  if (email === undefined) {
    logger.warn('email delivery off: no SMTP settings, emails stay queued');
    logger.info({ email_delivery: 'off' }, 'worker ready');
    return {
      stop: async () => {
        clearInterval(keepAlive);
        await database.close();
      },
    };
  }

  const sender = overrides.emailSender ?? createSmtpEmailSender(email.smtp);
  const delivery = createOutboxDelivery({
    db: createDatabase(database),
    dataKeys: createDataKeys(localKeyWrapper(keys.kek)),
    sender,
    clock: overrides.clock ?? systemClock,
    linkBaseUrl: email.linkBaseUrl,
    logger,
  });
  logger.info({ email_delivery: 'on' }, 'worker ready');
  const outbox: Poller = startPoller(
    () => delivery.deliverDue(),
    overrides.pollIntervalMs ?? OUTBOX_POLL_MS,
    (error) => {
      logger.error({ err: error }, 'email delivery round failed');
    },
  );
  return {
    stop: async () => {
      clearInterval(keepAlive);
      await outbox.stop();
      sender.close();
      await database.close();
    },
  };
}
