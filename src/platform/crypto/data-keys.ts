import sodium, { type SecureBuffer } from 'sodium-native';
import { generateDataKey, type KeyWrapper, type WrappedKey } from './key-wrapper.ts';

/**
 * Plaintext data keys exist only in guarded memory and only for one unit of work, then they are wiped. There is no
 * cache: with the KEK held locally (ADR-0013) unwrapping costs microseconds, so keeping keys longer would only
 * lengthen their exposure (ADR-0006 allowed up to 5 minutes for a remote KMS).
 */
export interface DataKeys {
  /** A new data key for `userId`: `work` stores the wrapped form and encrypts with the key. */
  withNewKey<T>(userId: string, work: (dataKey: SecureBuffer, wrapped: WrappedKey) => Promise<T>): Promise<T>;
  /** Unwraps `userId`'s stored data key for the duration of `work`. */
  withKey<T>(userId: string, wrapped: WrappedKey, work: (dataKey: SecureBuffer) => Promise<T>): Promise<T>;
}

async function wipeAfter<T>(dataKey: SecureBuffer, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } finally {
    sodium.sodium_memzero(dataKey);
  }
}

export function createDataKeys(wrapper: KeyWrapper): DataKeys {
  return {
    async withNewKey(userId, work) {
      const dataKey = generateDataKey();
      return wipeAfter(dataKey, () => work(dataKey, wrapper.wrap(dataKey, userId)));
    },
    async withKey(userId, wrapped, work) {
      const dataKey = wrapper.unwrap(wrapped, userId);
      return wipeAfter(dataKey, () => work(dataKey));
    },
  };
}
