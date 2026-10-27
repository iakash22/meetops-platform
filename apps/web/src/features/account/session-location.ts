import type { SessionSummary } from '@meetops/contracts';

/**
 * Approximate IP geolocation on a session. Techy is adding these as nullable fields to
 * contracts `SessionSummary`; until that lands they are declared here (same names), optional.
 * Values are rendered as plain text only.
 */
export type SessionGeo = {
  geoCity?: string | null;
  geoRegion?: string | null;
  geoCountry?: string | null;
  geoCountryCode?: string | null;
  geoApproximate?: boolean | null;
};
export type SessionWithGeo = SessionSummary & SessionGeo;

const clean = (v: string | null | undefined) => (typeof v === 'string' ? v.trim() : '') || null;

/**
 * 'City, Region, Country' when all are known; else 'City, Country'; else 'Region, Country';
 * else 'Country'; else 'Unknown location'.
 */
export function formatLocation(g: SessionGeo): string {
  const city = clean(g.geoCity);
  const region = clean(g.geoRegion);
  const country = clean(g.geoCountry);
  if (city && region && country) return `${city}, ${region}, ${country}`;
  if (city && country) return `${city}, ${country}`;
  if (region && country) return `${region}, ${country}`;
  if (country) return country;
  return 'Unknown location';
}

/** Regional-indicator flag for an ISO 3166-1 alpha-2 code; null for anything else. */
export function countryFlag(code: string | null | undefined): string | null {
  const c = clean(code)?.toUpperCase();
  if (!c || !/^[A-Z]{2}$/.test(c)) return null;
  return String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

const key = (v: string | null | undefined) => clean(v)?.toLowerCase() ?? null;

/**
 * True when this session's country or region differs from the current device's session.
 * Only compares fields known on both sides, so missing geo never raises a false alarm.
 */
export function isNewLocation(s: SessionWithGeo, current: SessionWithGeo | undefined): boolean {
  if (!current || s.id === current.id) return false;
  const country = (g: SessionGeo) => key(g.geoCountryCode) ?? key(g.geoCountry);
  const [a, b] = [country(s), country(current)];
  if (a && b && a !== b) return true;
  const [ra, rb] = [key(s.geoRegion), key(current.geoRegion)];
  return !!(ra && rb && ra !== rb && (!a || !b || a === b));
}
