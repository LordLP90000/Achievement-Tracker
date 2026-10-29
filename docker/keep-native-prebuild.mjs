// Keeps only the native prebuild of the platform the image is built for (sodium-native ships 15 platforms, ~24 MB)
// and fails the build if that one is missing. Runs in the production-dependencies stage of docker/Dockerfile.
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const directory = 'node_modules/sodium-native/prebuilds';
const keep = `${process.platform}-${process.arch}`;

if (!existsSync(join(directory, keep))) {
  throw new Error(`sodium-native has no prebuild for ${keep}`);
}
for (const entry of readdirSync(directory)) {
  if (entry !== keep) rmSync(join(directory, entry), { recursive: true, force: true });
}
