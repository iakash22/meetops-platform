import { resolveOrigins, type Origins } from './origins.js';

/** Path of the web pairing page (owned by apps/web). It receives the nonce, deviceId and extensionId in the fragment. */
export const WEB_PAIR_PATH = '/extension/pair';

/** ADR-005 A1.1.2: the nonce is deleted after one use or after 5 minutes. */
export const NONCE_TTL_MS = 5 * 60 * 1000;
/** Refresh the access token this long before it expires. */
export const REFRESH_SKEW_MS = 60 * 1000;

export type AuthConfig = Origins;

/**
 * Origins baked in at build time. wxt.config.ts validates WXT_WEB_ORIGIN / WXT_API_ORIGIN (failing the build on a bad
 * value) and defines them, so import.meta.env always carries the validated values; they are re-checked here.
 */
export function authConfig(): AuthConfig {
  const env = import.meta.env as Record<string, string | boolean | undefined>;
  return resolveOrigins(env, env.DEV === true);
}
