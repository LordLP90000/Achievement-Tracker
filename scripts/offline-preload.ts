// Preload for development tools: `node --import ./scripts/offline-preload.ts <tool> …` (see scripts/offline.ts).
import { refuseConnections } from './offline.ts';

refuseConnections((line) => {
  process.stderr.write(line);
});
