import { BlockList, isIP } from 'node:net';
import { normalizeIp } from '@meetops/config';

// normalizeIp is shared with realtime (@meetops/config); re-exported for existing callers.
export { normalizeIp };

/** Non-public ranges (RFC 6890 special-purpose, documentation, CGNAT, multicast, ...): GeoIP returns null for these. */
const NON_PUBLIC = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  NON_PUBLIC.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
] as const)
  NON_PUBLIC.addSubnet(net, prefix, 'ipv6');

export function isPublicIp(ip: string): boolean {
  const v = normalizeIp(ip);
  if (!v) return false;
  return !NON_PUBLIC.check(v, isIP(v) === 4 ? 'ipv4' : 'ipv6');
}

/**
 * For logs: IPv4 truncated to /24 (`203.0.113.0/24`), IPv6 to /48. Never log a full IP at info level (ADR-014).
 * Not a hash: an unkeyed hash of an IPv4 address is brute-forceable.
 */
export function truncateIp(ip: string | null | undefined): string | null {
  if (!ip) return null;
  const v = normalizeIp(ip);
  if (!v) return 'invalid';
  if (isIP(v) === 4) return `${v.split('.').slice(0, 3).join('.')}.0/24`;
  const groups = expandV6(v);
  return `${groups.slice(0, 3).join(':')}::/48`;
}

function expandV6(v: string): string[] {
  const [head, tail] = v.split('::') as [string, string | undefined];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array<string>(8 - h.length - t.length).fill('0');
  return [...h, ...fill, ...t].map((g) =>
    g.includes('.') ? g : g.toLowerCase().replace(/^0+(?=.)/, ''),
  );
}
