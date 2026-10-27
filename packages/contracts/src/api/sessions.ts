import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime, UNSAFE_DISPLAY_TEXT_CHARS, UNSAFE_DISPLAY_TEXT_TAGS } from '../common.js';
import { CursorPage } from './pagination.js';

const strict = { additionalProperties: false } as const;

/**
 * Coarse location text (city, region or country name) from GeoIP (ADR-014). mmdb data is third-party input, so it uses
 * the shared unsafe display-text set (control chars incl. CR/LF, bidi/invisible chars, `<`, `>`, `"`, tag chars; no
 * leading or trailing whitespace) EXCEPT ASCII `'` and `&`, which real place names need ("St. John's",
 * "Trinidad & Tobago"). It also rejects values that look like an IPv4 or IPv6 address, so an IP cannot be smuggled into
 * "no IP" payloads, including the CIDR form ("10.0.0.0/8", "2001:db8::/32"). This is input validation, not output encoding: every renderer (email HTML, web, push) must still
 * escape these values.
 */
const GEO_UNSAFE_CHARS = UNSAFE_DISPLAY_TEXT_CHARS.replace("'", '').replace('&', '');
const GEO_SAFE_CHAR = `(?:(?!${UNSAFE_DISPLAY_TEXT_TAGS})[^${GEO_UNSAFE_CHARS}])`;
export const GEO_TEXT_PATTERN =
  '^(?!\\d{1,3}(?:\\.\\d{1,3}){3}(?:\\/\\d{1,3})?$)' +
  '(?![0-9A-Fa-f.]*:[0-9A-Fa-f:.]*(?:%[\\w.-]+)?(?:\\/\\d{1,3})?$)' +
  `(?!\\s)${GEO_SAFE_CHAR}+(?<!\\s)$`;
export const GeoName = Type.String({ minLength: 1, maxLength: 128, pattern: GEO_TEXT_PATTERN });
/** ISO 3166-1 alpha-2 country code, upper case. */
export const GeoCountryCodeString = Type.String({ pattern: '^[A-Z]{2}$' });
/** Nullable variants, used where a field is always present (outbox event). */
export const GeoText = Type.Union([GeoName, Type.Null()]);
export const GeoCountryCode = Type.Union([GeoCountryCodeString, Type.Null()]);

/** Why `auth.new_location_signin` fired (ADR-014). */
export const NEW_LOCATION_REASONS = ['new_region', 'new_country'] as const;
export const NewLocationReason = Type.Union(NEW_LOCATION_REASONS.map((r) => Type.Literal(r)));
export type NewLocationReason = Static<typeof NewLocationReason>;

/** Outbox event type for a sign-in from a new region or country. */
export const AUTH_NEW_LOCATION_SIGNIN_EVENT = 'auth.new_location_signin' as const;

/**
 * Outbox payload of `auth.new_location_signin` (ADR-014). **Never carries an IP address.** Every key is required and
 * the geo values are nullable (not optional): the event is produced server-side, so it always has every key.
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
    // Optional, not nullable: absent means unknown.
    geoCity: Type.Optional(GeoName),
    geoCountry: Type.Optional(GeoName),
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
    // Coarse GeoIP location (ADR-014, 0.14.0). Each field is OPTIONAL, NOT nullable: absent means unknown
    // (private/unknown IP, no GeoIP database, or an older server). One representation for "unknown" avoids clients
    // handling both missing and null. No latitude/longitude is ever exposed.
    geoCity: Type.Optional(GeoName),
    geoRegion: Type.Optional(GeoName),
    geoCountry: Type.Optional(GeoName),
    geoCountryCode: Type.Optional(GeoCountryCodeString),
    /** Present (always `true`) whenever any geo field is present: GeoIP locations are approximate. */
    geoApproximate: Type.Optional(Type.Literal(true)),
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
