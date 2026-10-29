import { createHmac } from 'node:crypto';
import { parseAddress } from '../audit/ip-prefix.ts';

/**
 * Bucket keys (Q-14, threat I-19): HMAC-SHA256 under a key derived per UTC day from `RATE_LIMIT_KEY`, so the table
 * never holds an IP address or an email, and buckets of different days cannot be linked to each other.
 */

/** The day's key: HMAC(RATE_LIMIT_KEY, "questline|v1|rate-limit|YYYY-MM-DD"). */
export function dailyKey(rateLimitKey: Uint8Array, now: Date): Buffer {
  return createHmac('sha256', rateLimitKey)
    .update(`questline|v1|rate-limit|${now.toISOString().slice(0, 10)}`, 'utf8')
    .digest();
}

export function bucketKey(day: Uint8Array, scope: string, subject: string): Buffer {
  return createHmac('sha256', day).update(`${scope}:${subject}`, 'utf8').digest();
}

/** IPv4 per address, IPv6 per /64 — a single customer network, not one of its many addresses. */
export function ipSubject(address: string): string {
  const parsed = parseAddress(address);
  if (parsed === undefined) return `raw:${address}`;
  if (parsed.family === 4) return `v4:${parsed.octets.join('.')}`;
  return `v6:${parsed.hextets
    .slice(0, 4)
    .map((hextet) => hextet.toString(16))
    .join(':')}`;
}
