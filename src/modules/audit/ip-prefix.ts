import { isIPv4, isIPv6 } from 'node:net';

/**
 * The network of a client address for audit events: IPv4 /24, IPv6 /48 (data inventory C8). A full address is
 * never stored. IPv4-mapped IPv6 addresses count as IPv4. Returns `null` when the address cannot be parsed.
 */
export function ipPrefix(address: string): string | null {
  if (isIPv4(address)) return ipv4Prefix(address);
  const zoneStart = address.indexOf('%');
  const withoutZone = zoneStart === -1 ? address : address.slice(0, zoneStart);
  if (!isIPv6(withoutZone)) return null;
  const hextets = expandIpv6(withoutZone.toLowerCase());
  if (hextets.slice(0, 5).every((hextet) => hextet === 0) && hextets[5] === 0xffff) {
    const [high = 0, low = 0] = hextets.slice(6);
    return `${String(high >> 8)}.${String(high & 0xff)}.${String(low >> 8)}.0/24`;
  }
  const network = hextets.slice(0, 3);
  while (network.at(-1) === 0) network.pop();
  return `${network.map((hextet) => hextet.toString(16)).join(':')}::/48`;
}

function ipv4Prefix(address: string): string {
  return `${address.split('.').slice(0, 3).join('.')}.0/24`;
}

/** The eight 16-bit groups of a valid IPv6 address, including `::` and a trailing dotted IPv4 part. */
function expandIpv6(address: string): number[] {
  const groupsOf = (part: string): number[] =>
    part === ''
      ? []
      : part.split(':').flatMap((group) => {
          if (!group.includes('.')) return [Number.parseInt(group, 16)];
          const [a = 0, b = 0, c = 0, d = 0] = group.split('.').map(Number);
          return [(a << 8) | b, (c << 8) | d];
        });
  const [head = '', tail] = address.split('::');
  const left = groupsOf(head);
  const right = tail === undefined ? [] : groupsOf(tail);
  return [...left, ...Array<number>(8 - left.length - right.length).fill(0), ...right];
}
