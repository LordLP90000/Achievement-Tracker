import type { Logger } from 'pino';
import type { BootstrapConfig, MigrateConfig } from '../platform/config/config.ts';
import { bootstrapDatabase } from '../platform/db/bootstrap.ts';
import { runMigrations } from '../platform/db/migrate.ts';

export async function migrateCommand(config: MigrateConfig, logger: Logger): Promise<void> {
  await runMigrations(config.databaseUrl);
  logger.info('migrations applied');
}

export async function bootstrapCommand(config: BootstrapConfig, logger: Logger): Promise<void> {
  await bootstrapDatabase(config.adminUrl, { database: config.database, passwords: config.passwords });
  logger.info({ database: config.database }, 'database bootstrapped');
}
