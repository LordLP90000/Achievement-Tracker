import { createHmac, randomBytes } from 'node:crypto';
import { base32 } from './base32.ts';
import { constantTimeEqual } from './compare.ts';

/**
 * TOTP (RFC 6238 over RFC 4226's HOTP) with HMAC-SHA1, 6 digits and 30-second steps — what authenticator apps use by
 * default (ADR-0019). A code counts for the current step and one step either side, for clocks that drift, and never
 * for a step at or before the last one accepted, so no code works twice (RFC 6238 §5.2).
 */

export const TOTP = Object.freeze({
  algorithm: 'SHA1',
  digits: 6,
  periodSeconds: 30,
  /** RFC 4226 §4 recommends 160 bits. */
  secretBytes: 20,
  driftSteps: 1,
});

const ISSUER = 'Questline';

export function newTotpSecret(): Buffer {
  return randomBytes(TOTP.secretBytes);
}

/** Whole periods since the Unix epoch. */
export function totpStep(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP.periodSeconds);
}

/** HOTP (RFC 4226 §5.3): dynamic truncation of HMAC-SHA1 over the 8-byte counter, as decimal digits. */
export function hotp(secret: Uint8Array, counter: number, digits: number = TOTP.digits): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  // HMAC-SHA1, as RFC 6238 and every authenticator app use it: SHA-1's collisions do not weaken HMAC (RFC 6194 §3).
  const mac = createHmac('sha1', secret).update(message).digest(); // nosemgrep: questline-weak-hash
  const offset = (mac.at(-1) ?? 0) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7f_ff_ff_ff;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * The step a presented code belongs to — the earliest of the current step and one either side that is later than
 * `lastStep` — or `undefined`. Each comparison takes constant time; anything but 6 digits never matches.
 */
export function acceptTotp(secret: Uint8Array, code: string, now: Date, lastStep: number | null): number | undefined {
  const presented = Buffer.from(code);
  const current = totpStep(now);
  for (let step = Math.max(0, current - TOTP.driftSteps); step <= current + TOTP.driftSteps; step += 1) {
    const unused = lastStep === null || step > lastStep;
    if (unused && constantTimeEqual(Buffer.from(hotp(secret, step)), presented)) return step;
  }
  return undefined;
}

/** The key URI authenticator apps read from a QR code: issuer, account, secret and parameters. */
export function otpauthUri(secret: Uint8Array, account: string): string {
  const label = `${ISSUER}:${encodeURIComponent(account)}`;
  const parameters = new URLSearchParams({
    secret: base32(secret),
    issuer: ISSUER,
    algorithm: TOTP.algorithm,
    digits: String(TOTP.digits),
    period: String(TOTP.periodSeconds),
  });
  return `otpauth://totp/${label}?${parameters.toString()}`;
}
