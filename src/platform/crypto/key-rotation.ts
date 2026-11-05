import sodium, { type SecureBuffer } from 'sodium-native';
import { DecryptionError } from './aead.ts';
import type { Kek } from './kek-source.ts';
import { localKeyWrapper, type WrappedKey } from './key-wrapper.ts';

/** What re-wrapping did to one data key (ADR-0020). */
export type Rewrap =
  /** The current KEK opens it and it carries the current item's label: nothing to do. */
  | { readonly outcome: 'current' }
  /** Now wrapped by the current KEK, with its labels; the caller stores it. */
  | { readonly outcome: 'rewrapped'; readonly wrapped: WrappedKey }
  /** No given KEK opens it: left as it is. */
  | { readonly outcome: 'unknown' };

/** The data key, if `kek` opens it for this user whatever the label says; `undefined` if the AEAD refuses it. */
function opened(kek: Kek, wrapped: WrappedKey, userId: string): SecureBuffer | undefined {
  try {
    return localKeyWrapper(kek).unwrap({ ...wrapped, kekId: kek.id }, userId);
  } catch (error) {
    if (error instanceof DecryptionError) return undefined;
    throw error;
  }
}

/**
 * A data key wrapped by the current KEK (KEK rotation, ADR-0020, Q-56). The current KEK is tried first, then each
 * previous one, and the AEAD decides which fits, never the label: a local rotation labels both keys `local`. A key
 * the current KEK opens stays as it is when it carries the current item's label (an edit of the item changes no key),
 * and is relabelled otherwise. The plaintext data key exists only in guarded memory and is wiped after the wrap.
 */
export function rewrapDataKey(wrapped: WrappedKey, userId: string, current: Kek, previous: readonly Kek[]): Rewrap {
  for (const kek of [current, ...previous]) {
    const dataKey = opened(kek, wrapped, userId);
    if (dataKey === undefined) continue;
    try {
      if (kek === current && wrapped.kekId === current.id) return { outcome: 'current' };
      return { outcome: 'rewrapped', wrapped: localKeyWrapper(current).wrap(dataKey, userId) };
    } finally {
      sodium.sodium_memzero(dataKey);
    }
  }
  return { outcome: 'unknown' };
}
