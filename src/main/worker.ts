import type { Logger } from 'pino';
import { retentionJobs } from '../modules/privacy/retention.ts';
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
import { createScheduler, type ScheduledJob } from '../platform/jobs/scheduler.ts';
import { systemClock, type Clock } from '../platform/time/clock.ts';
import type { Stoppable } from './shutdown.ts';

/** How often the worker looks for due emails: a verification email leaves within seconds of the request. */
export const OUTBOX_POLL_MS = 5_000;
/** How often the worker checks which scheduled jobs are due; each job has its own interval (hourly retention). */
export const SCHEDULER_TICK_MS = 60_000;

/** The worker decrypts queued email payloads with user data keys, so it needs the KEK (R-ENC-05). */
export interface WorkerKeyMaterial {
  readonly kek: Kek;
}

/** Replaceable parts for tests; production sends through the SMTP relay and runs the retention jobs. */
export interface WorkerOverrides {
  readonly emailSender?: EmailSender;
  readonly clock?: Clock;
  readonly pollIntervalMs?: number;
  readonly jobs?: readonly ScheduledJob[];
  readonly schedulerTickMs?: number;
}

/**
 * Starts the background worker with the `questline_worker` database role: it runs the scheduled jobs (retention,
 * ADR-0009) and drains the email outbox (ADR-0014). Settlement and hard-deletion jobs follow in M3–M4.
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

  const db = createDatabase(database);
  const clock = overrides.clock ?? systemClock;
  const { email } = config;
  const outbox =
    email === undefined ? undefined : { email, sender: overrides.emailSender ?? createSmtpEmailSender(email.smtp) };
  if (outbox === undefined) logger.warn('email delivery off: no SMTP settings, emails stay queued');
  logger.info({ email_delivery: outbox === undefined ? 'off' : 'on' }, 'worker ready');

  const scheduler = createScheduler({ db, clock, logger, jobs: overrides.jobs ?? retentionJobs() });
  const pollers: Poller[] = [
    startPoller(
      () => scheduler.runDue(),
      overrides.schedulerTickMs ?? SCHEDULER_TICK_MS,
      (error) => {
        logger.error({ err: error }, 'scheduled jobs failed');
      },
    ),
  ];
  if (outbox !== undefined) {
    const delivery = createOutboxDelivery({
      db,
      dataKeys: createDataKeys(localKeyWrapper(keys.kek)),
      sender: outbox.sender,
      clock,
      linkBaseUrl: outbox.email.linkBaseUrl,
      logger,
    });
    pollers.push(
      startPoller(
        () => delivery.deliverDue(),
        overrides.pollIntervalMs ?? OUTBOX_POLL_MS,
        (error) => {
          logger.error({ err: error }, 'email delivery round failed');
        },
      ),
    );
  }
  return {
    stop: async () => {
      await Promise.all(pollers.map((poller) => poller.stop()));
      outbox?.sender.close();
      await database.close();
    },
  };
}
