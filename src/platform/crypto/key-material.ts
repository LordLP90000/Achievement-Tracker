/** Decodes key material given as base64 or base64url (environment variables, 1Password fields). */

const ENCODED = /^[\w+/-]+={0,2}$/;

/**
 * The decoded bytes, or `undefined` when the value is not base64, has the wrong length or consists of one repeated
 * byte (a placeholder such as all zeros is not a key).
 */
export function decodeKeyMaterial(value: string, minBytes: number, maxBytes: number): Buffer | undefined {
  if (!ENCODED.test(value)) return undefined;
  const bytes = Buffer.from(value, 'base64');
  const first = bytes[0];
  if (bytes.length < minBytes || bytes.length > maxBytes || bytes.every((byte) => byte === first)) {
    bytes.fill(0);
    return undefined;
  }
  return bytes;
}
