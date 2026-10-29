import sodium from 'sodium-native';

/** Authenticated encryption for field values and wrapped keys (XChaCha20-Poly1305, ADR-0006). */

/** Sizes fixed by AEAD_XChaCha20_Poly1305 (draft-irtf-cfrg-xchacha); libsodium also checks them on every call. */
export const AEAD_KEY_BYTES = 32;
const NONCE_BYTES = 24;
const TAG_BYTES = 16;
const FORMAT_VERSION = 0x01;
const HEADER_BYTES = 1 + NONCE_BYTES;

const UUID_V4 = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;
const COLUMN = /^[a-z][a-z\d_]*$/;

/** Any failure to decrypt: wrong key, wrong associated data, tampering, truncation or an unknown format. */
export class DecryptionError extends Error {
  override readonly name = 'DecryptionError';

  constructor() {
    super('decryption failed');
  }
}

export interface FieldContext {
  readonly userId: string;
  readonly recordId: string;
  /** Column name, e.g. `email_enc`. */
  readonly field: string;
}

function requireUuid(value: string, what: string): string {
  if (!UUID_V4.test(value)) throw new RangeError(`${what} must be a lower-case UUID v4`);
  return value;
}

/** `questline|v1|<user_id>|<record_id>|<field>`: a value only decrypts in the row and column it was written for. */
export function fieldAssociatedData(context: FieldContext): Buffer {
  if (!COLUMN.test(context.field)) throw new RangeError('field must be a lower-case column name');
  const userId = requireUuid(context.userId, 'userId');
  const recordId = requireUuid(context.recordId, 'recordId');
  return Buffer.from(`questline|v1|${userId}|${recordId}|${context.field}`, 'utf8');
}

/** `questline|v1|dek|<user_id>`: a wrapped data key only unwraps for its user and never as a field value. */
export function keyWrapAssociatedData(userId: string): Buffer {
  return Buffer.from(`questline|v1|dek|${requireUuid(userId, 'userId')}`, 'utf8');
}

function requireKey(key: Uint8Array): void {
  if (key.length !== AEAD_KEY_BYTES) throw new RangeError(`key must be ${String(AEAD_KEY_BYTES)} bytes`);
}

/** Encrypts with a fresh random nonce: `0x01 ‖ nonce(24) ‖ ciphertext ‖ tag(16)`. */
export function seal(key: Uint8Array, plaintext: Uint8Array, associatedData: Uint8Array): Buffer {
  requireKey(key);
  const blob = Buffer.alloc(HEADER_BYTES + plaintext.length + TAG_BYTES);
  blob[0] = FORMAT_VERSION;
  const nonce = blob.subarray(1, HEADER_BYTES);
  sodium.randombytes_buf(nonce);
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
    blob.subarray(HEADER_BYTES),
    plaintext,
    associatedData,
    null,
    nonce,
    key,
  );
  return blob;
}

/**
 * Verifies and decrypts a sealed value. Pass `out` (exactly the plaintext length) to decrypt straight into guarded
 * memory, so a secret such as a data key never sits in an ordinary buffer.
 */
export function open(key: Uint8Array, blob: Uint8Array, associatedData: Uint8Array, out?: Buffer): Buffer {
  requireKey(key);
  if (blob.length < HEADER_BYTES + TAG_BYTES || blob[0] !== FORMAT_VERSION) throw new DecryptionError();
  const plaintextBytes = blob.length - HEADER_BYTES - TAG_BYTES;
  if (out !== undefined && out.length !== plaintextBytes) {
    throw new RangeError(`out must be exactly ${String(plaintextBytes)} bytes`);
  }
  const target = out ?? Buffer.alloc(plaintextBytes);
  try {
    sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      target,
      null,
      blob.subarray(HEADER_BYTES),
      associatedData,
      blob.subarray(1, HEADER_BYTES),
      key,
    );
  } catch {
    throw new DecryptionError();
  }
  return target;
}
