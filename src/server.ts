import { startApi } from './main/api.ts';
import { runCli } from './main/cli.ts';
import { stopOnSignals } from './main/shutdown.ts';
import { loadApiConfig } from './platform/config/config.ts';
import { createLogger } from './platform/logging/logger.ts';

process.exitCode = await runCli(
  async () => {
    const config = loadApiConfig(process.env);
    const logger = createLogger({ service: 'questline-api', level: config.logLevel });
    stopOnSignals(process, await startApi(config, logger), logger);
  },
  (line) => process.stderr.write(`${line}\n`),
);
