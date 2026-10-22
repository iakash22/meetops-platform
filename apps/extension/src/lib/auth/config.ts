/**
 * ADR-005 pairing configuration.
 *
 * TODO(devops): the production origins are placeholders until DevOps publishes the real ones; they must match the
 * web app origin (externally_connectable) and the API origin exactly. Dev builds may override them via
 * WXT_MEETOPS_WEB_ORIGIN / WXT_MEETOPS_API_ORIGIN; store builds always use the production values.
 */
export const PROD_WEB_ORIGIN = 'https://app.meetops.ai';
export const PROD_API_ORIGIN = 'https://api.meetops.ai';

/** Path of the web pairing page (owned by apps/web). It receives the nonce, deviceId and extensionId in the fragment. */
export const WEB_PAIR_PATH = '/extension/pair';

/** ADR-005 A1.1.2: the nonce is deleted after one use or after 5 minutes. */
export const NONCE_TTL_MS = 5 * 60 * 1000;
/** Refresh the access token this long before it expires. */
export const REFRESH_SKEW_MS = 60 * 1000;

export interface AuthConfig {
  webOrigin: string;
  apiOrigin: string;
}

function devOverride(name: string, fallback: string): string {
  const env = import.meta.env as Record<string, string | boolean | undefined>;
  const v = env[name];
  return env.DEV === true && typeof v === 'string' && v.length > 0 ? v : fallback;
}

export function authConfig(): AuthConfig {
  return {
    webOrigin: devOverride('WXT_MEETOPS_WEB_ORIGIN', PROD_WEB_ORIGIN),
    apiOrigin: devOverride('WXT_MEETOPS_API_ORIGIN', PROD_API_ORIGIN),
  };
}
