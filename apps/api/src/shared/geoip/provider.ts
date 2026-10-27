import {
  GEO_TEXT_PATTERN,
  UNSAFE_DISPLAY_TEXT_CHARS,
  UNSAFE_DISPLAY_TEXT_TAGS,
} from '@meetops/contracts';
import { isPublicIp, normalizeIp } from './ip.js';

/** Coarse location (ADR-014). No latitude/longitude, accuracy radius or postal code is ever read or stored. */
export interface GeoLocation {
  city: string | null;
  region: string | null;
  country: string | null;
  /** ISO 3166-1 alpha-2, upper case. */
  countryCode: string | null;
}

/**
 * Swappable GeoIP source (ADR-002/ADR-014). Implementations are LOCAL lookups only (an mmdb file read into memory);
 * a per-request call to an external API is not allowed. DB-IP City Lite today; MaxMind GeoLite2 City has the same
 * record shape and can drop in through GEOIP_DB_PATH.
 */
export interface GeoIpProvider {
  readonly name: string;
  /** Raw lookup for a public IP; null when unknown. Callers use lookupGeo(), which filters private IPs. */
  lookupPublic(ip: string): GeoLocation | null;
}

export const nullGeoIpProvider: GeoIpProvider = { name: 'none', lookupPublic: () => null };

/** Session / audit columns (ADR-014). All null when the IP is private, reserved or unknown. */
export interface GeoFields {
  geoCity: string | null;
  geoRegion: string | null;
  geoCountry: string | null;
  geoCountryCode: string | null;
  geoApproximate: true | null;
}

export const EMPTY_GEO: GeoFields = Object.freeze({
  geoCity: null,
  geoRegion: null,
  geoCountry: null,
  geoCountryCode: null,
  geoApproximate: null,
});

const GEO_TEXT_RE = new RegExp(GEO_TEXT_PATTERN);
// Characters that never belong in a place name: the contracts unsafe display-text set (controls, CR/LF, bidi and
// invisible format chars, variation selectors, <, >, ") minus ASCII ' and &, plus tag characters (mirrors GeoName).
const STRIP_RE = new RegExp(
  `[${UNSAFE_DISPLAY_TEXT_CHARS.replace("'", '').replace('&', '')}]|${UNSAFE_DISPLAY_TEXT_TAGS}`,
  'g',
);

/** Third-party text -> contracts-safe place name, or null (also null when it looks like an IP). */
export function safeGeoText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.replace(STRIP_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, 128).trim();
  return s && GEO_TEXT_RE.test(s) ? s : null;
}

export function safeCountryCode(v: unknown): string | null {
  return typeof v === 'string' && /^[A-Za-z]{2}$/.test(v) ? v.toUpperCase() : null;
}

/** Lookup with the private/reserved filter and a never-throw guarantee (lookups must not break sign-in). */
export function lookupGeo(provider: GeoIpProvider, ip: string | null | undefined): GeoFields {
  const v = ip ? normalizeIp(ip) : null;
  if (!v || !isPublicIp(v)) return EMPTY_GEO;
  let loc: GeoLocation | null;
  try {
    loc = provider.lookupPublic(v);
  } catch {
    return EMPTY_GEO;
  }
  if (!loc) return EMPTY_GEO;
  const f = {
    geoCity: safeGeoText(loc.city),
    geoRegion: safeGeoText(loc.region),
    geoCountry: safeGeoText(loc.country),
    geoCountryCode: safeCountryCode(loc.countryCode),
  };
  const any = f.geoCity ?? f.geoRegion ?? f.geoCountry ?? f.geoCountryCode;
  return any === null ? EMPTY_GEO : { ...f, geoApproximate: true };
}
