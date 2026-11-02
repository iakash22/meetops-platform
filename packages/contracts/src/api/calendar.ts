import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime, SafeDisplayText } from '../common.js';
import { HttpsUrl } from '../domain/media.js';
import { RETURN_TO_PATTERN } from './integrations.js';

const strict = { additionalProperties: false } as const;

export { CALENDAR_PATHS, CALENDAR_PROVIDERS } from '../constants.js';
import { CALENDAR_PROVIDERS } from '../constants.js';

export const CalendarProviderId = Type.Union(CALENDAR_PROVIDERS.map((p) => Type.Literal(p)));
export type CalendarProviderId = (typeof CALENDAR_PROVIDERS)[number];

export const CalendarConnectionStatus = Type.Union([
  Type.Literal('active'),
  Type.Literal('error'),
  Type.Literal('revoked'),
]);
export type CalendarConnectionStatus = Static<typeof CalendarConnectionStatus>;

/** The caller's own calendar connection. Never carries tokens, ciphertext or key ids. */
export const CalendarConnection = Type.Object(
  {
    id: Id,
    organizationId: Id,
    userId: Id,
    provider: CalendarProviderId,
    status: CalendarConnectionStatus,
    displayName: SafeDisplayText({ maxLength: 200, trimmed: true }),
    externalAccountId: Type.String({ minLength: 1, maxLength: 320 }),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  },
  strict,
);
export type CalendarConnection = Static<typeof CalendarConnection>;

export const CalendarProviderStatus = Type.Object(
  {
    provider: CalendarProviderId,
    /** false when the OAuth client is not configured on this deployment (connect answers 503). */
    configured: Type.Boolean(),
    connection: Type.Optional(CalendarConnection),
  },
  strict,
);
export type CalendarProviderStatus = Static<typeof CalendarProviderStatus>;
export const CalendarProviderList = Type.Object(
  { items: Type.Array(CalendarProviderStatus, { maxItems: 10 }) },
  strict,
);
export type CalendarProviderList = Static<typeof CalendarProviderList>;

/** returnTo is a same-origin web path only (no scheme/host), defaulting to /calendar. */
export const ConnectCalendarRequest = Type.Object(
  {
    provider: CalendarProviderId,
    returnTo: Type.Optional(
      Type.String({ minLength: 1, maxLength: 512, pattern: RETURN_TO_PATTERN }),
    ),
  },
  strict,
);
export type ConnectCalendarRequest = Static<typeof ConnectCalendarRequest>;
export const ConnectCalendarResponse = Type.Object({ authorizeUrl: HttpsUrl }, strict);
export type ConnectCalendarResponse = Static<typeof ConnectCalendarResponse>;

export const CalendarCallbackParams = Type.Object({ provider: CalendarProviderId }, strict);
export const CalendarCallbackQuery = Type.Object(
  {
    state: Type.String({ minLength: 1, maxLength: 256 }),
    code: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
    error: Type.Optional(Type.String({ maxLength: 128 })),
    scope: Type.Optional(Type.String({ maxLength: 2048 })),
    authuser: Type.Optional(Type.String({ maxLength: 16 })),
    prompt: Type.Optional(Type.String({ maxLength: 64 })),
    hd: Type.Optional(Type.String({ maxLength: 255 })),
  },
  strict,
);
export type CalendarCallbackQuery = Static<typeof CalendarCallbackQuery>;

export const CalendarConnectionParams = Type.Object(
  { organizationId: Id, connectionId: Id },
  strict,
);

/** Window is capped server-side at 62 days. */
export const ListCalendarEventsQuery = Type.Object({ from: IsoDateTime, to: IsoDateTime }, strict);
export type ListCalendarEventsQuery = Static<typeof ListCalendarEventsQuery>;

export const CalendarEvent = Type.Object(
  {
    id: Type.String({ minLength: 1, maxLength: 1024 }),
    connectionId: Id,
    provider: CalendarProviderId,
    title: Type.String({ minLength: 1, maxLength: 500 }),
    startsAt: IsoDateTime,
    endsAt: IsoDateTime,
    allDay: Type.Boolean(),
    status: Type.Union([
      Type.Literal('confirmed'),
      Type.Literal('tentative'),
      Type.Literal('cancelled'),
    ]),
    conferenceUrl: Type.Optional(HttpsUrl),
    htmlLink: Type.Optional(HttpsUrl),
    organizerEmail: Type.Optional(Type.String({ maxLength: 320 })),
    attendeeCount: Type.Integer({ minimum: 0 }),
    /** The meeting this event is linked to (PUT .../events/:eventId/link). Absent when unlinked. */
    meetingId: Type.Optional(Id),
    /**
     * Auto-match, never stored: the organization's meeting whose external call id equals the one derived from
     * `conferenceUrl` (same rule as meetings/resolve). Only set when the event is not linked and exactly one meeting
     * matches; clients offer it as a one-click link.
     */
    suggestedMeetingId: Type.Optional(Id),
  },
  strict,
);
export type CalendarEvent = Static<typeof CalendarEvent>;
export const CalendarEventList = Type.Object(
  { items: Type.Array(CalendarEvent, { maxItems: 500 }) },
  strict,
);
export type CalendarEventList = Static<typeof CalendarEventList>;

/** Provider event ids (Google: base32hex, recurring instances add `_<timestamp>`). Path-safe charset only. */
export const CalendarEventId = Type.String({
  minLength: 1,
  maxLength: 1024,
  pattern: '^[A-Za-z0-9_.:@-]+$',
});
export const CalendarEventLinkParams = Type.Object(
  { organizationId: Id, connectionId: Id, eventId: CalendarEventId },
  strict,
);
export type CalendarEventLinkParams = Static<typeof CalendarEventLinkParams>;
export const LinkCalendarEventRequest = Type.Object({ meetingId: Id }, strict);
export type LinkCalendarEventRequest = Static<typeof LinkCalendarEventRequest>;
/** A link between one of the caller's calendar events and a meeting of the same organization. */
export const CalendarEventLink = Type.Object(
  {
    connectionId: Id,
    eventId: CalendarEventId,
    meetingId: Id,
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
  },
  strict,
);
export type CalendarEventLink = Static<typeof CalendarEventLink>;
