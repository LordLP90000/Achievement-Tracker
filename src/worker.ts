import { runCli } from './main/cli.ts';
import { kekSourceFor } from './main/keys.ts';
import { stopOnSignals } from './main/shutdown.ts';
import { startWorker } from './main/worker.ts';
import { loadWorkerConfig } from './platform/config/config.ts';
import { loadWorkerKeys } from './platform/config/keys.ts';
import { createLogger } from './platform/logging/logger.ts';

process.exitCode = await runCli(
  async () => {
    const config = loadWorkerConfig(process.env);
    const keys = loadWorkerKeys(process.env, config.appEnv);
    const logger = createLogger({ service: 'questline-worker', level: config.logLevel });
    // The worker decrypts queued email payloads with user data keys: without the KEK it does not start.
    await kekSourceFor(keys.kek)();
    stopOnSignals(process, await startWorker(config, logger), logger);
  },
  (line) => process.stderr.write(`${line}\n`),
);
