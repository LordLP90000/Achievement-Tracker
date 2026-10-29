import sodium, { type SecureBuffer } from 'sodium-native';
import { z } from 'zod';
import { decodeKeyMaterial } from './key-material.ts';

/**
 * Source of the key-encryption key (KEK), read once at startup (ADR-0013, R-ENC-05). Production reads it from the
 * self-hosted 1Password Connect server; development and tests use a local key. Any failure stops the process.
 */

export interface Kek {
  /** 32 bytes in guarded memory; never logged, never persisted. */
  readonly key: SecureBuffer;
  /** Stored with every wrapped data key: `local`, or `onepassword:<vault>/<item>`. */
  readonly id: string;
  readonly version: number;
}

export type KekSource = () => Promise<Kek>;

/** The KEK could not be obtained. Only a code is kept: it is all the log is allowed to see. */
export class KekSourceError extends Error {
  override readonly name = 'KekSourceError';
  readonly code: string;

  constructor(code: string) {
    super(`KEK unavailable (${code})`);
    this.code = code;
  }
}

const KEK_BYTES = 32;
const MAX_ITEM_BYTES = 64 * 1024;
const ONEPASSWORD_ID = /^[a-z\d]{26}$/;

const itemSchema = z.object({
  version: z.number().int().min(1),
  vault: z.object({ id: z.string() }),
  fields: z.array(z.object({ label: z.string().optional(), value: z.string().optional() })),
});

function guarded(material: Uint8Array): SecureBuffer {
  const key = sodium.sodium_malloc(KEK_BYTES);
  key.set(material);
  return key;
}

/** Development and tests only (`KEK_SOURCE=env`); production configuration refuses it. Wipes the given buffer. */
export function envKekSource(localKek: Buffer): KekSource {
  if (localKek.length !== KEK_BYTES) throw new RangeError('the KEK must be 32 bytes');
  const kek: Kek = { key: guarded(localKek), id: 'local', version: 1 };
  sodium.sodium_memzero(localKek);
  return () => Promise.resolve(kek);
}

export interface OnePasswordConnectOptions {
  /** Base URL of the Connect server, e.g. `https://op-connect.internal:8443` (validated by the configuration). */
  readonly url: URL;
  readonly token: string;
  readonly vaultId: string;
  readonly itemId: string;
  readonly timeoutMs: number;
}

async function fetchItem(endpoint: URL, options: OnePasswordConnectOptions): Promise<string> {
  try {
    // nosemgrep: questline-non-constant-outbound-url -- operator-configured Connect server, validated at startup
    const response = await fetch(endpoint, {
      headers: { authorization: `Bearer ${options.token}`, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new KekSourceError(`connect_http_${String(response.status)}`);
    }
    return await response.text();
  } catch (error) {
    if (error instanceof KekSourceError) throw error;
    throw new KekSourceError(
      error instanceof Error && error.name === 'TimeoutError' ? 'connect_timeout' : 'connect_unreachable',
    );
  }
}

function kekField(body: string, vaultId: string): { value: string; version: number } {
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new KekSourceError('invalid_item');
  }
  const item = itemSchema.safeParse(json);
  const value = item.data?.fields.find((field) => field.label === 'kek')?.value;
  if (Buffer.byteLength(body) > MAX_ITEM_BYTES || item.data?.vault.id !== vaultId || value === undefined) {
    throw new KekSourceError('invalid_item');
  }
  return { value, version: item.data.version };
}

/** Production: `GET /v1/vaults/{vault}/items/{item}` on the Connect server; the KEK is the item's `kek` field. */
export function onePasswordConnectKekSource(options: OnePasswordConnectOptions): KekSource {
  if (!ONEPASSWORD_ID.test(options.vaultId) || !ONEPASSWORD_ID.test(options.itemId)) {
    throw new RangeError('1Password vault and item IDs must be 26 lower-case letters or digits');
  }
  const endpoint = new URL(`/v1/vaults/${options.vaultId}/items/${options.itemId}`, options.url);

  return async () => {
    const { value, version } = kekField(await fetchItem(endpoint, options), options.vaultId);
    const material = decodeKeyMaterial(value, KEK_BYTES, KEK_BYTES);
    if (material === undefined) throw new KekSourceError('invalid_kek');
    try {
      return { key: guarded(material), id: `onepassword:${options.vaultId}/${options.itemId}`, version };
    } finally {
      sodium.sodium_memzero(material);
    }
  };
}
