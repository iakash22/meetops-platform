import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';
import { MeetingSource } from '../domain/meeting.js';
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
