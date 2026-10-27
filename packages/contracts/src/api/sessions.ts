import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';
import { CursorPage } from './pagination.js';

const strict = { additionalProperties: false } as const;

/** Nullable coarse location text (city, region or country name) from GeoIP (ADR-014). */
export const GeoText = Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]);
/** Nullable ISO 3166-1 alpha-2 country code, upper case. */
export const GeoCountryCode = Type.Union([Type.String({ pattern: '^[A-Z]{2}$' }), Type.Null()]);

/** Why `auth.new_location_signin` fired (ADR-014). */
export const NEW_LOCATION_REASONS = ['new_region', 'new_country'] as const;
export const NewLocationReason = Type.Union(NEW_LOCATION_REASONS.map((r) => Type.Literal(r)));
export type NewLocationReason = Static<typeof NewLocationReason>;

/** Outbox event type for a sign-in from a new region or country. */
export const AUTH_NEW_LOCATION_SIGNIN_EVENT = 'auth.new_location_signin' as const;

/**
 * Outbox payload of `auth.new_location_signin` (ADR-014). **Never carries an IP address.**
 */
export const AuthNewLocationSigninEvent = Type.Object(
  {
    sessionId: Id,
    city: GeoText,
    region: GeoText,
    country: GeoText,
    countryCode: GeoCountryCode,
    reason: NewLocationReason,
  },
  strict,
);
export type AuthNewLocationSigninEvent = Static<typeof AuthNewLocationSigninEvent>;

/**
 * Payload of the in-app notification item built from `auth.new_location_signin` (what the feed exposes).
 * The fan-out maps `city` -> `geoCity` and `country` -> `geoCountry`. No IP address.
 */
export const AuthNewLocationSigninNotificationPayload = Type.Object(
  {
    sessionId: Id,
    reason: NewLocationReason,
    geoCity: Type.Optional(GeoText),
    geoCountry: Type.Optional(GeoText),
  },
  strict,
);
export type AuthNewLocationSigninNotificationPayload = Static<
  typeof AuthNewLocationSigninNotificationPayload
>;

/**
 * One of the caller's active sessions (devices), for `GET /auth/sessions`. `current` marks the session making the request.
 * **Never carries token material**: no session token, token hash, CSRF token or refresh token. The schema is strict, so
 * a serializer that adds such a field fails validation.
 */
export const SessionSummary = Type.Object(
  {
    id: Id,
    current: Type.Boolean(),
    createdAt: IsoDateTime,
    lastSeenAt: IsoDateTime,
    expiresAt: IsoDateTime,
    ip: Type.Union([Type.String({ maxLength: 45 }), Type.Null()]),
    userAgent: Type.Union([Type.String({ maxLength: 1024 }), Type.Null()]),
    // Coarse GeoIP location (ADR-014, 0.14.0). Null for private/unknown IPs. Optional during rollout so older
    // servers still validate; clients must treat missing as null. No latitude/longitude is ever exposed.
    geoCity: Type.Optional(GeoText),
    geoRegion: Type.Optional(GeoText),
    geoCountry: Type.Optional(GeoText),
    geoCountryCode: Type.Optional(GeoCountryCode),
    /** True whenever the location came from GeoIP (always approximate). */
    geoApproximate: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])),
  },
  strict,
);
export type SessionSummary = Static<typeof SessionSummary>;

/** GET /auth/sessions: cursor page of SessionSummary (`nextCursor` is null on the last page). */
export const ListSessionsResponse = Type.Object(CursorPage(SessionSummary).properties, strict);
export type ListSessionsResponse = Static<typeof ListSessionsResponse>;

/** DELETE /auth/sessions/:sessionId path params. */
export const SessionIdParams = Type.Object({ sessionId: Id }, strict);
export type SessionIdParams = Static<typeof SessionIdParams>;
