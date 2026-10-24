/**
 * Build-time origin configuration (ADR-005). The production domain is not final, so the web and API origins come
 * from WXT env vars and are validated when wxt.config.ts loads (a bad value fails the build):
 *
 *   WXT_WEB_ORIGIN  default https://app.meetops.ai  (pairing page; the only externally_connectable origin)
 *   WXT_API_ORIGIN  default https://api.meetops.ai  (the only origin that receives the bearer token)
 *
 * Pure and dependency-free so wxt.config.ts, the runtime and tests share it.
 */
export const DEFAULT_WEB_ORIGIN = 'https://app.meetops.ai';
export const DEFAULT_API_ORIGIN = 'https://api.meetops.ai';

export interface Origins {
  webOrigin: string;
  apiOrigin: string;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Validate one origin: a bare origin (scheme://host[:port], no path, trailing slash, query, fragment or
 * credentials), https only. localhost/loopback is allowed only when `dev` is true (and then http is allowed too).
 */
export function validateOrigin(name: string, value: string, dev: boolean): string {
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL: ${JSON.stringify(value)}`);
  }
  const local = LOCAL_HOSTS.has(u.hostname) || u.hostname.endsWith('.localhost');
  if (local && !dev) throw new Error(`${name} may use localhost only in dev builds`);
  if (u.protocol !== 'https:' && !(local && dev && u.protocol === 'http:')) {
    throw new Error(`${name} must use https: ${JSON.stringify(value)}`);
  }
  if (u.origin !== value) {
    throw new Error(
      `${name} must be a bare origin like https://app.example.com (no path, trailing slash, query or credentials): ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/** Resolve both origins from env (empty or unset values fall back to the defaults) and validate them. */
export function resolveOrigins(
  env: Record<string, string | boolean | undefined>,
  dev: boolean,
): Origins {
  const pick = (k: string, d: string) => {
    const v = env[k];
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : d;
  };
  return {
    webOrigin: validateOrigin('WXT_WEB_ORIGIN', pick('WXT_WEB_ORIGIN', DEFAULT_WEB_ORIGIN), dev),
    apiOrigin: validateOrigin('WXT_API_ORIGIN', pick('WXT_API_ORIGIN', DEFAULT_API_ORIGIN), dev),
  };
}

/** externally_connectable match pattern for a web origin. */
export const originMatch = (origin: string) => `${origin}/*`;
