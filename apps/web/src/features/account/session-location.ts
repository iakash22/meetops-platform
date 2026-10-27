import type { SessionSummary } from '@meetops/contracts';

/** Geo fields come straight from contracts 0.14 `SessionSummary` (optional; absent = unknown). */
export type SessionGeo = Pick<
  SessionSummary,
  'geoCity' | 'geoRegion' | 'geoCountry' | 'geoCountryCode' | 'geoApproximate'
>;

/** Longest location string ever rendered (defence in depth; contracts already cap each part). */
export const MAX_LOCATION_LENGTH = 80;

export const DBIP_ATTRIBUTION = 'IP geolocation by DB-IP';
export const DBIP_URL = 'https://db-ip.com';

const clean = (v: string | null | undefined) => (typeof v === 'string' ? v.trim() : '') || null;

const cap = (s: string, max = MAX_LOCATION_LENGTH) =>
  s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s;

/**
 * 'City, Region, Country' when all are known; else 'City, Country'; else 'Region, Country';
 * else 'Country'; else null (unknown: render nothing). Length-capped; plain text only.
 */
export function formatLocation(g: SessionGeo): string | null {
  const city = clean(g.geoCity);
  const region = clean(g.geoRegion);
  const country = clean(g.geoCountry);
  let out: string | null = null;
  if (city && region && country) out = `${city}, ${region}, ${country}`;
  else if (city && country) out = `${city}, ${country}`;
  else if (region && country) out = `${region}, ${country}`;
  else if (country) out = country;
  return out === null ? null : cap(out);
}

/** Upper-cased code iff it is exactly two ASCII letters A–Z; otherwise null. */
export function validCountryCode(code: string | null | undefined): string | null {
  if (typeof code !== 'string') return null;
  const raw = code.trim();
  // Check ASCII before upper-casing: Unicode case mapping can turn 'ﬀ' into 'FF' or 'ß' into 'SS'.
  if (!/^[A-Za-z]{2}$/.test(raw)) return null;
  const c = raw.toUpperCase();
  return /^[A-Z]{2}$/.test(c) ? c : null;
}

/** Regional-indicator flag for an ISO 3166-1 alpha-2 code; null for anything else. */
export function countryFlag(code: string | null | undefined): string | null {
  const c = validCountryCode(code);
  if (!c) return null;
  return String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65));
}

const key = (v: string | null | undefined) => clean(v)?.toLowerCase() ?? null;

/**
 * True when this session's country or region differs from the current device's session.
 * Only compares fields known on both sides, so missing geo never raises a false alarm.
 */
export function isNewLocation(s: SessionSummary, current: SessionSummary | undefined): boolean {
  if (!current || s.id === current.id) return false;
  const country = (g: SessionGeo) =>
    validCountryCode(g.geoCountryCode)?.toLowerCase() ?? key(g.geoCountry);
  const [a, b] = [country(s), country(current)];
  if (a && b && a !== b) return true;
  const [ra, rb] = [key(s.geoRegion), key(current.geoRegion)];
  return !!(ra && rb && ra !== rb && (!a || !b || a === b));
}
