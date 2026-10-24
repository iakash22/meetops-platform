import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { AIError } from '../errors.js';

export type DnsLookup = (host: string) => Promise<Array<{ address: string; family: number }>>;
const defaultLookup: DnsLookup = (host) => dnsLookup(host, { all: true, verbatim: true });

export type EndpointPolicy = {
  /** Hostnames (exact, lower-case) allowed for remote providers. Backend-controlled; never user input. */
  allowedHosts: string[];
  /** Local endpoints (URL origin, e.g. "http://localhost:11434") allowed ONLY when that local provider is enabled. */
  allowedLocalOrigins: string[];
};

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
  ['192.0.2.0', 24], ['198.51.100.0', 24], ['203.0.113.0', 24], // TEST-NET-1/2/3 (documentation)
  ['192.88.99.0', 24], // 6to4 relay anycast (deprecated)
] as const) blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::1', 128], ['::', 128],
  ['::', 96], // IPv4-compatible IPv6 (deprecated; embeds IPv4, e.g. ::7f00:1); covers :: and ::1 too
  ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
  ['64:ff9b::', 96], // NAT64
  ['64:ff9b:1::', 48], // local-use NAT64
  ['2002::', 16], // 6to4 (embeds arbitrary IPv4)
  ['2001::', 32], // Teredo (embeds arbitrary IPv4)
  ['2001:db8::', 32], // documentation
  ['100::', 64], // discard-only
  ['fd00:ec2::254', 128], // AWS IMDS IPv6 (also inside fc00::/7)
] as const) blocked.addSubnet(net, bits, 'ipv6');

const mapped = new BlockList();
mapped.addSubnet('::ffff:0:0', 96, 'ipv6');

/** True for loopback, private, link-local, CGNAT, multicast, reserved, IPv4-mapped and cloud-metadata addresses. Non-IPs are unsafe. */
export function isPrivateAddress(address: string): boolean {
  const v = isIP(address);
  if (v === 4) return blocked.check(address, 'ipv4');
  if (v === 6) {
    // IPv4-mapped (::ffff:a.b.c.d or ::ffff:XXXX:XXXX, any expanded form): blocked outright,
    // stricter than checking the embedded v4. (node BlockList's ::ffff:0:0/96 would also match plain IPv4.)
    if (mapped.check(address, 'ipv6')) return true;
    return blocked.check(address, 'ipv6');
  }
  return true;
}

export type SafeEndpoint = {
  url: URL;
  /** Validated address to pin the TCP connection to (undefined for allowlisted local origins). */
  pinned?: { address: string; family: 4 | 6 } | undefined;
  local: boolean;
};

/**
 * Validate an outbound provider URL: scheme (HTTPS only), backend host allowlist, resolved IPs.
 * Rejects if ANY resolved address is private/reserved. Returns the IP to pin (DNS-rebinding defence).
 * Exception: exact origins in `allowedLocalOrigins` (enabled self-hosted providers) may use http + private IPs.
 */
export async function assertSafeEndpoint(rawUrl: string, policy: EndpointPolicy, lookup: DnsLookup = defaultLookup): Promise<SafeEndpoint> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new AIError('SSRF_BLOCKED', 'Invalid URL', { retryable: false });
  }
  const block = (m: string) => new AIError('SSRF_BLOCKED', m, { retryable: false });
  if (url.username || url.password) throw block('Credentials in URL are not allowed');
  if (policy.allowedLocalOrigins.includes(url.origin)) {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw block(`Scheme ${url.protocol} not allowed`);
    return { url, local: true };
  }
  if (url.protocol !== 'https:') throw block(`Scheme ${url.protocol} not allowed (HTTPS only)`);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!policy.allowedHosts.includes(host)) throw block(`Host ${host} is not allowlisted`);
  // SEC-BUG-1: remote providers only on the default HTTPS port (WHATWG URL normalizes ':443' to ''). Exact local origins returned above.
  if (url.port !== '' && url.port !== '443') throw block(`Port ${url.port} not allowed`);
  const fam = isIP(host);
  const addrs = fam ? [{ address: host, family: fam }] : await lookup(host);
  if (addrs.length === 0) throw block(`Host ${host} did not resolve`);
  for (const a of addrs) if (isPrivateAddress(a.address)) throw block(`Host ${host} resolves to a private/reserved address`);
  const first = addrs[0]!;
  return { url, local: false, pinned: { address: first.address, family: first.family === 6 ? 6 : 4 } };
}

export const DEFAULT_ALLOWED_HOSTS = ['generativelanguage.googleapis.com', 'api.assemblyai.com', 'api.openai.com', 'api.deepgram.com'];
