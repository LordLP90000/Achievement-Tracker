import { timingSafeEqual } from 'node:crypto';

/** Compares secrets, digests and MACs in constant time (R-TLS-04, threat I-10). Lengths are not secret. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
