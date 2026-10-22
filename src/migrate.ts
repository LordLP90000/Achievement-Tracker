import { runCli } from './main/cli.ts';
import { migrateCommand } from './main/database.ts';
import { loadMigrateConfig } from './platform/config/config.ts';
import { createLogger } from './platform/logging/logger.ts';

process.exitCode = await runCli(
  async () => {
    const config = loadMigrateConfig(process.env);
    await migrateCommand(config, createLogger({ service: 'questline-migrate', level: config.logLevel }));
  },
  (line) => process.stderr.write(`${line}\n`),
);
