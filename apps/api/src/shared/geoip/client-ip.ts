// ADR-014 client-IP resolution lives in @meetops/config so the API and realtime share one implementation (no drift).
export {
  CLOUDFLARE_IPV4_RANGES,
  CLOUDFLARE_IPV6_RANGES,
  CLOUDFLARE_RANGES_FETCHED_AT,
  clientIpOptionsFromEnv,
  isCloudflareIp,
  resolveClientIp,
} from '@meetops/config';
export type { ClientIpOptions } from '@meetops/config';
