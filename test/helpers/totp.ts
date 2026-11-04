import { hotp, totpStep } from '../../src/platform/crypto/totp.ts';

/** What an authenticator app does with the secret of `POST /me/totp` (RFC 4648 base32, RFC 6238). */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function fromBase32(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const character of text) {
    const index = ALPHABET.indexOf(character);
    if (index < 0) throw new Error(`not base32: ${character}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** The app's code for `now`, or for a step before or after it. */
export function totpCode(secret: string, now: Date, stepOffset = 0): string {
  return hotp(fromBase32(secret), totpStep(now) + stepOffset);
}
