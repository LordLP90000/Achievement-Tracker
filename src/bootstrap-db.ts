import { runCli } from './main/cli.ts';
import { bootstrapCommand } from './main/database.ts';
import { loadBootstrapConfig } from './platform/config/config.ts';
import { createLogger } from './platform/logging/logger.ts';

process.exitCode = await runCli(
  async () => {
    const config = loadBootstrapConfig(process.env);
    await bootstrapCommand(config, createLogger({ service: 'questline-db-init', level: config.logLevel }));
  },
  (line) => process.stderr.write(`${line}\n`),
);
