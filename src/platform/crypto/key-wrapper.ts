import sodium, { type SecureBuffer } from 'sodium-native';
import { DecryptionError, keyWrapAssociatedData, open, seal } from './aead.ts';
import type { Kek } from './kek-source.ts';

/** Per-user data keys (DEKs) wrapped by the KEK (ADR-0006, ADR-0013). */

const DATA_KEY_BYTES = 32;
/** `0x01 ‖ nonce(24) ‖ encrypted key(32) ‖ tag(16)`. */
const WRAPPED_BYTES = 1 + 24 + DATA_KEY_BYTES + 16;

export interface WrappedKey {
  readonly blob: Buffer;
  readonly kekId: string;
  readonly kekVersion: number;
}

export interface KeyWrapper {
  wrap(dataKey: Uint8Array, userId: string): WrappedKey;
  /** The data key in guarded memory; throws `DecryptionError` for another user or a damaged blob. */
  unwrap(wrapped: WrappedKey, userId: string): SecureBuffer;
}

/** The data key was wrapped by a KEK this process does not hold (rotation needs the re-wrap job). */
export class UnknownKekError extends Error {
  override readonly name = 'UnknownKekError';

  constructor() {
    super('data key was wrapped by an unknown KEK');
  }
}

export function generateDataKey(): SecureBuffer {
  const dataKey = sodium.sodium_malloc(DATA_KEY_BYTES);
  sodium.randombytes_buf(dataKey);
  return dataKey;
}

/** XChaCha20-Poly1305 in-process with the KEK; associated data `questline|v1|dek|<user_id>`. */
export function localKeyWrapper(kek: Kek): KeyWrapper {
  return {
    wrap(dataKey, userId) {
      if (dataKey.length !== DATA_KEY_BYTES) throw new RangeError('a data key must be 32 bytes');
      return { blob: seal(kek.key, dataKey, keyWrapAssociatedData(userId)), kekId: kek.id, kekVersion: kek.version };
    },
    unwrap(wrapped, userId) {
      if (wrapped.kekId !== kek.id || wrapped.kekVersion !== kek.version) throw new UnknownKekError();
      if (wrapped.blob.length !== WRAPPED_BYTES) throw new DecryptionError();
      const dataKey = sodium.sodium_malloc(DATA_KEY_BYTES);
      open(kek.key, wrapped.blob, keyWrapAssociatedData(userId), dataKey);
      return dataKey;
    },
  };
}
