import { isIP } from 'node:net';

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

/**
 * Parses TRUST_PROXY into Fastify's trustProxy option.
 * - unset/empty/"false" → false (X-Forwarded-For is ignored; request.ip = socket address)
 * - integer "N"        → trust N hops (dev/test only: rejected when opts.production, ADR-014)
 * - "true"             → rejected (trusting every hop lets clients spoof their IP)
 * - "a,b/24,..."       → list of trusted proxy IPs/CIDRs; every entry is validated (startup fails otherwise)
 */
export function parseTrustProxy(
  value: string | undefined,
  opts: { production?: boolean } = {},
): boolean | string[] | ((address: string, hop: number) => boolean) {
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
