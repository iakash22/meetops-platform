import { BlockList, isIP } from 'node:net';
import { normalizeIp } from './ip.js';

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
 * Client IP for audit/geo (ADR-014). `peerIp` is Fastify's `request.ip`: the socket peer, or the first address that
 * is not one of the TRUST_PROXY allowlisted proxies. Raw X-Forwarded-For is never read here. CF-Connecting-IP is used
 * only when BEHIND_CLOUDFLARE=true AND that peer is a pinned Cloudflare edge address; otherwise it is ignored.
 */
export function resolveClientIp(
  peerIp: string | undefined,
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
