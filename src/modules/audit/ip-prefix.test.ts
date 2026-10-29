import { describe, expect, it } from 'vitest';
import { ipPrefix } from './ip-prefix.ts';

describe('ipPrefix (audit events keep networks, never addresses — data inventory C8)', () => {
  it.each([
    ['203.0.113.7', '203.0.113.0/24'],
    ['10.0.0.255', '10.0.0.0/24'],
    ['::ffff:203.0.113.7', '203.0.113.0/24'],
    ['::FFFF:cb00:7107', '203.0.113.0/24'],
    ['2001:db8:1234:5678:9abc:def0:1234:5678', '2001:db8:1234::/48'],
    ['2001:DB8:1234::1', '2001:db8:1234::/48'],
    ['2001:0db8:0001::1', '2001:db8:1::/48'],
    ['2001:db8::1', '2001:db8::/48'],
    ['0:db8:1::1', '0:db8:1::/48'],
    ['::1', '::/48'],
    ['fe80::1%eth0', 'fe80::/48'],
    ['64:ff9b::192.0.2.33', '64:ff9b::/48'],
  ])('truncates %s to %s', (address, prefix) => {
    expect(ipPrefix(address)).toBe(prefix);
  });

  it.each(['', 'unknown', '203.0.113', '2001:db8:::1', '1.2.3.4.5', '::ffff:999.0.0.1', '%eth0'])(
    'returns null for %j',
    (address) => {
      expect(ipPrefix(address)).toBeNull();
    },
  );
});
