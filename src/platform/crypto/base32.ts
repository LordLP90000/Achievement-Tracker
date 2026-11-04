/** Base32 without padding characters: 5 bits per character, the last character filled up with zero bits. */

/** RFC 4648 §6: what authenticator apps read a TOTP secret in. */
export const RFC4648 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
/** Crockford: no I, L, O or U, so a code read from paper is unambiguous. */
export const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function base32(bytes: Uint8Array, alphabet: string = RFC4648): string {
  const characters = Math.ceil((bytes.length * 8) / 5);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  value <<= BigInt(characters * 5 - bytes.length * 8);
  let output = '';
  for (let index = characters - 1; index >= 0; index -= 1) {
    output += alphabet.charAt(Number((value >> BigInt(index * 5)) & 31n));
  }
  return output;
}
