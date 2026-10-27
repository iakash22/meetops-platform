import {
  AUTH_NEW_LOCATION_SIGNIN_EVENT,
  type AuthNewLocationSigninEvent,
  type NewLocationReason,
} from '@meetops/contracts';
import type { GeoFields } from '../../../shared/geoip/provider.js';

/** A coarse location seen before for this user (from their earlier sessions). */
export interface KnownLocation {
  countryCode: string;
  region: string | null;
}

/**
 * ADR-014 new-location rule. No alert without a country code (private/unknown IP) or without history (the first
 * sign-in is the baseline). A country never seen -> 'new_country'; a known country with a region never seen there ->
 * 'new_region'. Region null on either side never alerts by itself.
 */
export function newLocationReason(
  geo: GeoFields,
  history: readonly KnownLocation[],
): NewLocationReason | null {
  const cc = geo.geoCountryCode;
  if (!cc || history.length === 0) return null;
  const sameCountry = history.filter((h) => h.countryCode === cc);
  if (sameCountry.length === 0) return 'new_country';
  if (!geo.geoRegion) return null;
  const regions = sameCountry.map((h) => h.region).filter((r): r is string => !!r);
  if (regions.length === 0) return null;
  return regions.includes(geo.geoRegion) ? null : 'new_region';
}

/** Outbox row for `auth.new_location_signin`. Strict contract payload: no IP, ever. */
export interface NewLocationOutboxEvent {
  organizationId: string;
  aggregateType: 'user';
  aggregateId: string;
  eventType: typeof AUTH_NEW_LOCATION_SIGNIN_EVENT;
  payload: AuthNewLocationSigninEvent;
}

export function buildNewLocationEvent(input: {
  organizationId: string;
  userId: string;
  sessionId: string;
  geo: GeoFields;
  reason: NewLocationReason;
}): NewLocationOutboxEvent {
  return {
    organizationId: input.organizationId,
    aggregateType: 'user',
    aggregateId: input.userId,
    eventType: AUTH_NEW_LOCATION_SIGNIN_EVENT,
    payload: {
      sessionId: input.sessionId,
      city: input.geo.geoCity,
      region: input.geo.geoRegion,
      country: input.geo.geoCountry,
      countryCode: input.geo.geoCountryCode,
      reason: input.reason,
    },
  };
}

/** Per-user limits (VPN flapping): one alert per (country, region) per 24 h, at most 3 alerts per user per 24 h. */
export const NEW_LOCATION_LIMITS = {
  perLocation: { limit: 1, windowMs: 24 * 60 * 60 * 1000 },
  perUser: { limit: 3, windowMs: 24 * 60 * 60 * 1000 },
} as const;
