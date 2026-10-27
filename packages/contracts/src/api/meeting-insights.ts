import { Type, type Static } from '@sinclair/typebox';
import { Id } from '../common.js';
import { Report, Transcript } from '../domain/meeting.js';

export { MEETING_INSIGHTS_PATHS } from '../constants.js';

/**
 * v0.8.0: meeting transcript and report reads, matching the API meeting-insights module:
 *   GET /orgs/:organizationId/meetings/:meetingId/transcript   -> MeetingTranscriptResponse (`Transcript`)
 *   GET /orgs/:organizationId/meetings/:meetingId/report       -> MeetingReportResponse (`Report`)
 * Both answer 404 until the artifact exists (clients show "not ready yet").
 */
export const MeetingInsightsParams = Type.Object(
  { organizationId: Id, meetingId: Id },
  { additionalProperties: false },
);
export type MeetingInsightsParams = Static<typeof MeetingInsightsParams>;

export const MeetingTranscriptResponse = Transcript;
export type MeetingTranscriptResponse = Static<typeof MeetingTranscriptResponse>;
export const MeetingReportResponse = Report;
export type MeetingReportResponse = Static<typeof MeetingReportResponse>;
