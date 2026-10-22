import { runCli } from './main/cli.ts';
import { stopOnSignals } from './main/shutdown.ts';
import { startWorker } from './main/worker.ts';
import { loadWorkerConfig } from './platform/config/config.ts';
import { createLogger } from './platform/logging/logger.ts';

process.exitCode = await runCli(
  async () => {
    const config = loadWorkerConfig(process.env);
    const logger = createLogger({ service: 'questline-worker', level: config.logLevel });
    stopOnSignals(process, await startWorker(config, logger), logger);
  },
  (line) => process.stderr.write(`${line}\n`),
);
