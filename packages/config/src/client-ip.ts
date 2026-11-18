import type { IncomingMessage } from 'node:http';
import { BlockList, isIP } from 'node:net';
import proxyAddr from '@fastify/proxy-addr';

/**
 * Shared client-IP resolution for the API and realtime (ADR-014). One implementation so the two services cannot drift:
 * - `parseTrustProxy` turns TRUST_PROXY into the value the API hands to Fastify's `trustProxy` option.
 * - `compileTrustProxy` turns that value into the same trust predicate Fastify builds from it.
 * - `resolveForwardedIp` walks X-Forwarded-For with that predicate using `@fastify/proxy-addr`, the library Fastify
 *   uses for `request.ip`. Realtime (raw Node/Socket.IO handshake, no Fastify request) calls it directly.
 * - `resolveClientIp` applies the BEHIND_CLOUDFLARE / pinned-edge rule on top.
 * The `Forwarded` (RFC 7239) header is never read, by either service.
 */

/** True for an IPv4/IPv6 address or a CIDR with a valid prefix length. */
export function isIpOrCidr(entry: string): boolean {
  const [ip, prefix, ...rest] = entry.split('/');
  if (rest.length || !ip) return false;
  const family = isIP(ip);
  if (!family) return false;
  if (prefix === undefined) return true;
  if (!/^\d{1,3}$/.test(prefix)) return false;
  const n = Number(prefix);
  // A /0 trusts every address (0.0.0.0/0, ::/0, ::0/0, ...): equivalent to TRUST_PROXY=true.
  if (n === 0) return false;
  return n >= 1 && n <= (family === 4 ? 32 : 128);
}

/** Trust predicate over the X-Forwarded-For chain: `hop` 0 is the socket peer, 1 the right-most XFF entry, ... */
export type TrustProxyFn = (address: string, hop: number) => boolean;

/** Parsed TRUST_PROXY: `false` (trust nothing), an IP/CIDR allowlist, or a dev/test-only hop-count predicate. */
export type TrustProxySetting = false | string[] | TrustProxyFn;

/**
 * Parses TRUST_PROXY (same env name and rules for the API and realtime).
 * - unset/empty/"false" → false (X-Forwarded-For is ignored; the client IP is the socket address)
 * - integer "N"        → trust N hops (dev/test only: rejected when opts.production, ADR-014)
 * - "true"             → rejected (trusting every hop lets clients spoof their IP)
 * - "a,b/24,..."       → list of trusted proxy IPs/CIDRs; every entry is validated (startup fails otherwise)
 */
export function parseTrustProxy(
  value: string | undefined,
  opts: { production?: boolean } = {},
): TrustProxySetting {
  const v = value?.trim();
  if (!v || v === 'false') return false;
  if (v === 'true')
    throw new Error(
      'TRUST_PROXY=true is not allowed; use a hop count or a list of proxy IPs/CIDRs',
    );
  if (/^\d+$/.test(v)) {
    // ADR-014: a hop count trusts a forged left-most X-Forwarded-For whenever an extra hop exists.
    if (opts.production) {
      throw new Error(
        'TRUST_PROXY hop counts are not allowed in production; use a comma list of proxy IPs/CIDRs',
      );
    }
    const hops = parseInt(v, 10);
    return (_address: string, hop: number) => hop < hops;
  }
  const entries = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const invalid = entries.filter((e) => !isIpOrCidr(e));
  if (invalid.length)
    throw new Error(`TRUST_PROXY has invalid IP/CIDR entries: ${invalid.join(', ')}`);
  return entries;
}

/**
 * The trust predicate Fastify derives from a `parseTrustProxy` result (fastify lib/request.js getTrustProxyFn):
 * false trusts nothing, a function is used as-is, a list is compiled by `@fastify/proxy-addr` (IPv4-mapped IPv6
 * peers match IPv4 entries).
 */
export function compileTrustProxy(setting: TrustProxySetting): TrustProxyFn {
  if (setting === false) return () => false;
  if (typeof setting === 'function') return setting;
  if (setting.length === 0) return () => false;
  return proxyAddr.compile(setting);
}

/** Strip an IPv4-mapped IPv6 prefix (::ffff:a.b.c.d) and an IPv6 zone id. Null when not an IP. */
export function normalizeIp(ip: string): string | null {
  let v = ip.trim();
  const zone = v.indexOf('%');
  if (zone !== -1) v = v.slice(0, zone);
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(v);
  if (m) v = m[1]!;
  return isIP(v) ? v : null;
}

/**
 * Client address after the TRUST_PROXY allowlist, i.e. what Fastify's `request.ip` is for the same peer and headers:
 * starting at the socket peer, walk X-Forwarded-For from the right while the current hop is trusted, and stop at the
 * first untrusted address. X-Forwarded-For is ignored entirely unless the socket peer itself is trusted, so a direct
 * client cannot pick its own key. The result is normalised (IPv4-mapped IPv6 → IPv4). If the chosen entry is not a
 * valid IP (a trusted proxy forwarded garbage), the nearest valid address to its right is used, ending at the socket
 * peer. Null only when the socket peer itself is missing or invalid.
 */
export function resolveForwardedIp(
  peer: string | undefined,
  xForwardedFor: string | string[] | undefined,
  trust: TrustProxyFn,
): string | null {
  if (!peer) return null;
  // A repeated header is joined like Node joins it for IncomingMessage.headers (comma list, first to last).
  const xff = Array.isArray(xForwardedFor) ? xForwardedFor.join(', ') : xForwardedFor;
  const req = {
    socket: { remoteAddress: peer },
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  } as unknown as IncomingMessage;
  const chain = proxyAddr.all(req, trust); // [peer, right-most XFF, ...] truncated at the first untrusted hop
  for (let i = chain.length - 1; i >= 0; i--) {
    const ip = normalizeIp(chain[i]!);
    if (ip) return ip;
  }
  return null;
}

/**
 * Cloudflare edge ranges, PINNED from https://www.cloudflare.com/ips-v4 and /ips-v6 (fetched 2026-10-28). Refresh by a
 * reviewed PR, never at runtime. If Cloudflare adds a range and this list is stale, the header is ignored (fail closed).
 */
export const CLOUDFLARE_RANGES_FETCHED_AT = '2026-10-28';
export const CLOUDFLARE_IPV4_RANGES = [
  '173.245.48.0/20',
  '103.21.244.0/22',
  '103.22.200.0/22',
  '103.31.4.0/22',
  '141.101.64.0/18',
  '108.162.192.0/18',
  '190.93.240.0/20',
  '188.114.96.0/20',
  '197.234.240.0/22',
  '198.41.128.0/17',
  '162.158.0.0/15',
  '104.16.0.0/13',
  '104.24.0.0/14',
  '172.64.0.0/13',
  '131.0.72.0/22',
] as const;
export const CLOUDFLARE_IPV6_RANGES = [
  '2400:cb00::/32',
  '2606:4700::/32',
  '2803:f800::/32',
  '2405:b500::/32',
  '2405:8100::/32',
  '2a06:98c0::/29',
  '2c0f:f248::/32',
] as const;

const CF = new BlockList();
for (const r of CLOUDFLARE_IPV4_RANGES) {
  const [net, p] = r.split('/') as [string, string];
  CF.addSubnet(net, Number(p), 'ipv4');
}
for (const r of CLOUDFLARE_IPV6_RANGES) {
  const [net, p] = r.split('/') as [string, string];
  CF.addSubnet(net, Number(p), 'ipv6');
}

export function isCloudflareIp(ip: string): boolean {
  const v = normalizeIp(ip);
  return !!v && CF.check(v, isIP(v) === 4 ? 'ipv4' : 'ipv6');
}

export interface ClientIpOptions {
  /** BEHIND_CLOUDFLARE=true. */
  behindCloudflare: boolean;
}

export function clientIpOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): ClientIpOptions {
  return { behindCloudflare: env.BEHIND_CLOUDFLARE?.trim().toLowerCase() === 'true' };
}

/**
 * Client IP for rate limits, audit and geo (ADR-014). `peerIp` is the address after the TRUST_PROXY allowlist
 * (Fastify's `request.ip` in the API, `resolveForwardedIp` in realtime). Raw X-Forwarded-For is never read here.
 * CF-Connecting-IP is used only when BEHIND_CLOUDFLARE=true AND that peer is a pinned Cloudflare edge address.
 */
export function resolveClientIp(
  peerIp: string | undefined | null,
  cfConnectingIp: string | string[] | undefined,
  opts: ClientIpOptions,
): string | null {
  const peer = peerIp ? normalizeIp(peerIp) : null;
  if (opts.behindCloudflare && peer && isCloudflareIp(peer) && typeof cfConnectingIp === 'string') {
    const cf = normalizeIp(cfConnectingIp);
    if (cf) return cf;
  }
  return peer;
}
