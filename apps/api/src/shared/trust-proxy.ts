// TRUST_PROXY parsing lives in @meetops/config so the API and realtime share one implementation (no drift).
export { isIpOrCidr, parseTrustProxy } from '@meetops/config';
export type { TrustProxySetting } from '@meetops/config';
