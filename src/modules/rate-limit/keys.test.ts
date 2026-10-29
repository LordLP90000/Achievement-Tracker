import { describe, expect, it } from 'vitest';
import { bucketKey, dailyKey, ipSubject } from './keys.ts';

describe('rate-limit keys [Q-14, I-19]', () => {
  const secret = Buffer.from('0123456789abcdef0123456789abcdef');
  const morning = new Date('2026-10-29T00:00:00Z');
  const evening = new Date('2026-10-29T23:59:59.999Z');
  const nextDay = new Date('2026-10-30T00:00:00Z');

  it('derives one key per UTC day, so yesterday’s buckets cannot be linked to today’s', () => {
    expect(dailyKey(secret, morning)).toEqual(dailyKey(secret, evening));
    expect(dailyKey(secret, nextDay)).not.toEqual(dailyKey(secret, evening));
    expect(dailyKey(Buffer.from('another secret of thirty-two b.'), morning)).not.toEqual(dailyKey(secret, morning));
  });

  it('stores a 32-byte keyed hash, never the subject itself', () => {
    const key = bucketKey(dailyKey(secret, morning), 'ip-auth', 'v4:203.0.113.7');

    expect(key).toHaveLength(32);
    expect(key.includes(Buffer.from('203.0.113'))).toBe(false);
  });

  it('separates scopes and subjects', () => {
    const today = dailyKey(secret, morning);
    const keys = [
      bucketKey(today, 'ip-auth', 'v4:203.0.113.7'),
      bucketKey(today, 'ip-auth', 'v4:203.0.113.8'),
      bucketKey(today, 'email-mail', 'v4:203.0.113.7'),
    ].map((key) => key.toString('hex'));

    expect(new Set(keys).size).toBe(3);
  });

  it.each([
    ['203.0.113.7', 'v4:203.0.113.7'],
    ['::ffff:203.0.113.7', 'v4:203.0.113.7'],
    ['2001:db8:1:2:3:4:5:6', 'v6:2001:db8:1:2'],
    ['2001:DB8:1:2::9', 'v6:2001:db8:1:2'],
    ['2001:db8::1', 'v6:2001:db8:0:0'],
    ['unknown', 'raw:unknown'],
  ])('limits %s as %s (IPv6 per /64: one customer network, not one rotating address)', (address, subject) => {
    expect(ipSubject(address)).toBe(subject);
  });
});
