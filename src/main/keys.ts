import type { KekSourceConfig, RotationKeys } from '../platform/config/keys.ts';
import { envKekSource, onePasswordConnectKekSource, type Kek, type KekSource } from '../platform/crypto/kek-source.ts';

/** How long the API and the worker wait for the 1Password Connect server at startup. */
export const CONNECT_TIMEOUT_MS = 5000;

export function kekSourceFor(config: KekSourceConfig): KekSource {
  return config.kind === 'env'
    ? envKekSource(config.localKek)
    : onePasswordConnectKekSource({
        url: config.url,
        token: config.token,
        vaultId: config.vaultId,
        itemId: config.itemId,
        timeoutMs: CONNECT_TIMEOUT_MS,
      });
}

/** The KEKs of a rotation (ADR-0020), each fetched from its source. */
export interface RotationKeks {
  readonly current: Kek;
  readonly previous: readonly Kek[];
}

export async function rotationKeks(keys: RotationKeys): Promise<RotationKeks> {
  return {
    current: await kekSourceFor(keys.current)(),
    previous: keys.previous === undefined ? [] : [await kekSourceFor(keys.previous)()],
  };
}
