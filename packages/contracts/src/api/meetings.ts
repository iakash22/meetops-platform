import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';
import { Meeting, MeetingSource, MeetingStatus } from '../domain/meeting.js';
import { CursorPage, CursorPageQuery } from './pagination.js';

export { MEETING_PATHS } from '../constants.js';
import { HttpsUrl } from '../domain/media.js';

const strict = { additionalProperties: false } as const;
const ExternalMeetingId = Type.String({
  minLength: 1,
  maxLength: 255,
  pattern: '^[A-Za-z0-9_.:@/-]+$',
});
const resolveCommon = {
  source: MeetingSource,
  title: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
  startedAt: Type.Optional(IsoDateTime),
};

/**
 * POST /orgs/:organizationId/meetings/resolve, called by the extension before recording.
 *
 * Finds or creates the meeting for an external call (Meet, Zoom or Teams). At least one of `externalMeetingUrl` or
 * `externalMeetingId` is required. **Idempotent per (organizationId, source, externalMeetingId)**: repeated calls
 * return the same `meetingId`, with `created: false`. When only a URL is sent, the server derives `externalMeetingId`
 * from it (normalized host and path).
 */
export const ResolveMeetingRequest = Type.Union([
  Type.Object(
    {
      ...resolveCommon,
      externalMeetingUrl: HttpsUrl,
      externalMeetingId: Type.Optional(ExternalMeetingId),
    },
    strict,
  ),
  Type.Object(
    {
      ...resolveCommon,
      externalMeetingId: ExternalMeetingId,
      externalMeetingUrl: Type.Optional(HttpsUrl),
    },
    strict,
  ),
]);
export type ResolveMeetingRequest = Static<typeof ResolveMeetingRequest>;

export const ResolveMeetingResponse = Type.Object({ meetingId: Id, created: Type.Boolean() });
export type ResolveMeetingResponse = Static<typeof ResolveMeetingResponse>;

/** Path params for GET /orgs/:organizationId/meetings/:meetingId (returns `Meeting`). */
export const GetMeetingParams = Type.Object({ organizationId: Id, meetingId: Id }, strict);
export type GetMeetingParams = Static<typeof GetMeetingParams>;

/**
 * Query for GET /orgs/:organizationId/meetings, returning `CursorPage<Meeting>` (v0.6.0; desktop PR #176, mobile).
 * Paged like ListTasksQuery: opaque `cursor` + `limit`. Order is newest first by (createdAt, id); the cursor is only
 * valid for the same filters. Filters combine with AND, an array `status` matches any value, and unknown params are
 * rejected. A single object schema (no union), so validators that reject `default` inside `anyOf` accept it.
 */
export const ListMeetingsQuery = Type.Object(
  {
    ...CursorPageQuery.properties,
    status: Type.Optional(
      Type.Union([
        MeetingStatus,
        Type.Array(MeetingStatus, { minItems: 1, maxItems: 5, uniqueItems: true }),
      ]),
    ),
    source: Type.Optional(MeetingSource),
    projectId: Type.Optional(Id),
    startedAfter: Type.Optional(IsoDateTime),
    startedBefore: Type.Optional(IsoDateTime),
    q: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
  },
  strict,
);
export type ListMeetingsQuery = Static<typeof ListMeetingsQuery>;

/** 200 body of GET /orgs/:organizationId/meetings: one page of the caller's organization only, newest first. */
export const ListMeetingsResponse = CursorPage(Meeting);
export type ListMeetingsResponse = Static<typeof ListMeetingsResponse>;

/** Path params for GET /orgs/:organizationId/meetings. */
export const ListMeetingsParams = Type.Object({ organizationId: Id }, strict);
export type ListMeetingsParams = Static<typeof ListMeetingsParams>;
