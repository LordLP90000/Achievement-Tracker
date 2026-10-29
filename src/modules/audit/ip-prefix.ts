import { isIPv4, isIPv6 } from 'node:net';

/** Parsed client addresses for audit prefixes (C8) and rate-limit subjects (Q-14). */
export type ParsedAddress =
  | { readonly family: 4; readonly octets: readonly number[] }
  | { readonly family: 6; readonly hextets: readonly number[] };

/** IPv4, or IPv6 (zone ID dropped); IPv4-mapped IPv6 addresses count as IPv4. `undefined` when unparseable. */
export function parseAddress(address: string): ParsedAddress | undefined {
  if (isIPv4(address)) return { family: 4, octets: address.split('.').map(Number) };
  const zoneStart = address.indexOf('%');
  const withoutZone = zoneStart === -1 ? address : address.slice(0, zoneStart);
  if (!isIPv6(withoutZone)) return undefined;
  const hextets = expandIpv6(withoutZone.toLowerCase());
  if (hextets.slice(0, 5).every((hextet) => hextet === 0) && hextets[5] === 0xffff) {
    const [high = 0, low = 0] = hextets.slice(6);
    return { family: 4, octets: [high >> 8, high & 0xff, low >> 8, low & 0xff] };
  }
  return { family: 6, hextets };
}

/**
 * The network of a client address for audit events: IPv4 /24, IPv6 /48 (data inventory C8). A full address is
 * never stored. Returns `null` when the address cannot be parsed.
 */
export function ipPrefix(address: string): string | null {
  const parsed = parseAddress(address);
  if (parsed === undefined) return null;
  if (parsed.family === 4) return `${parsed.octets.slice(0, 3).join('.')}.0/24`;
  const network = parsed.hextets.slice(0, 3);
  while (network.at(-1) === 0) network.pop();
  return `${network.map((hextet) => hextet.toString(16)).join(':')}::/48`;
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
