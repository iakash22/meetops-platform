/**
 * Parses TRUST_PROXY into Fastify's trustProxy option.
 * - unset/empty/"false" → false (X-Forwarded-For is ignored; request.ip = socket address)
 * - integer "N"        → trust N hops
 * - "true"             → rejected (trusting every hop lets clients spoof their IP)
 * - "a,b/24,..."       → list of trusted proxy IPs/CIDRs
 */
export function parseTrustProxy(
  value: string | undefined
): boolean | string[] | ((address: string, hop: number) => boolean) {
  const v = value?.trim();
  if (!v || v === 'false') return false;
  if (v === 'true') throw new Error('TRUST_PROXY=true is not allowed; use a hop count or a list of proxy IPs/CIDRs');
  if (/^\d+$/.test(v)) {
    const hops = parseInt(v, 10);
    return (_address: string, hop: number) => hop < hops;
  }
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}
