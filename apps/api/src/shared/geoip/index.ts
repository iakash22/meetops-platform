import { existsSync } from 'node:fs';
import { MmdbGeoIpProvider } from './mmdb-provider.js';
import { nullGeoIpProvider, type GeoIpProvider } from './provider.js';

export * from './provider.js';
export * from './ip.js';
export { MmdbGeoIpProvider } from './mmdb-provider.js';
export * from './client-ip.js';

/** Attribution required by CC BY 4.0 when GEOIP_PROVIDER=dbip; show it next to location values. */
export const DBIP_ATTRIBUTION = 'IP geolocation by DB-IP (https://db-ip.com), CC BY 4.0';

export interface GeoIpEnv {
  /** `dbip` (default when GEOIP_DB_PATH is set) | `geolite2` | `none`. No paid provider, no fallback. */
  GEOIP_PROVIDER?: string;
  /** Local path to the mmdb file (kept fresh by the monthly updater). */
  GEOIP_DB_PATH?: string;
}

/**
 * Builds the local provider. A missing or unreadable file gives the null provider (geo fields stay null; sign-in
 * keeps working) and a warning without the path's contents. Never falls back to another provider or a remote API.
 */
export function createGeoIpProvider(
  env: GeoIpEnv,
  log?: { warn(obj: object, msg: string): void },
): GeoIpProvider {
  const kind = (env.GEOIP_PROVIDER ?? (env.GEOIP_DB_PATH ? 'dbip' : 'none')).trim().toLowerCase();
  if (kind === 'none' || kind === '') return nullGeoIpProvider;
  if (kind !== 'dbip' && kind !== 'geolite2') {
    throw new Error(`GEOIP_PROVIDER must be dbip, geolite2 or none (got ${kind})`);
  }
  const path = env.GEOIP_DB_PATH?.trim();
  if (!path || !existsSync(path)) {
    log?.warn({ provider: kind }, 'GeoIP database file missing; location lookups disabled');
    return nullGeoIpProvider;
  }
  try {
    return new MmdbGeoIpProvider(path, kind === 'dbip' ? 'dbip-city-lite' : 'geolite2-city');
  } catch (err) {
    log?.warn(
      { provider: kind, errName: err instanceof Error ? err.name : 'unknown' },
      'GeoIP database unreadable; location lookups disabled',
    );
    return nullGeoIpProvider;
  }
}
