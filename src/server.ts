import { startApi } from './main/api.ts';
import { runCli } from './main/cli.ts';
import { kekSourceFor } from './main/keys.ts';
import { stopOnSignals } from './main/shutdown.ts';
import { loadApiConfig } from './platform/config/config.ts';
import { loadApiKeys } from './platform/config/keys.ts';
import { createLogger } from './platform/logging/logger.ts';

process.exitCode = await runCli(
  async () => {
    const config = loadApiConfig(process.env);
    const keys = loadApiKeys(process.env, config.appEnv);
    const logger = createLogger({ service: 'questline-api', level: config.logLevel });
    // Without the KEK no user data can be read or written: the API does not start (R-ENC-05).
    await kekSourceFor(keys.kek)();
    stopOnSignals(process, await startApi(config, logger), logger);
  },
  (line) => process.stderr.write(`${line}\n`),
);
