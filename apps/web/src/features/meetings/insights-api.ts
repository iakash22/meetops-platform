import type { Id, Report, Transcript } from '@meetops/contracts';
import { MEETING_INSIGHTS_PATHS } from '@meetops/contracts/types';
import type { HttpMethod } from '@/lib/api/client';

/**
 * Transcript and report reads for one meeting (Phase 3), served by the API meeting-insights module (#212).
 * Paths come from @meetops/contracts 0.8.0 MEETING_INSIGHTS_PATHS (pinned by a test). The API answers 404 until a
 * merged transcript or a report exists; the UI shows that as "not ready yet".
 */
export { MEETING_INSIGHTS_PATHS };

export type MeetingInsightsApi = {
  transcript: (organizationId: Id, meetingId: Id) => Promise<Transcript>;
  report: (organizationId: Id, meetingId: Id) => Promise<Report>;
};

export function insightsPath(template: string, organizationId: Id, meetingId: Id): string {
  return template
    .replace(':organizationId', encodeURIComponent(organizationId))
    .replace(':meetingId', encodeURIComponent(meetingId));
}

type Request = <T>(method: HttpMethod, path: string, body?: unknown) => Promise<T>;

export function createHttpMeetingInsightsApi(request: Request): MeetingInsightsApi {
  return {
    transcript: (o, m) => request('GET', insightsPath(MEETING_INSIGHTS_PATHS.transcript, o, m)),
    report: (o, m) => request('GET', insightsPath(MEETING_INSIGHTS_PATHS.report, o, m)),
  };
}

/** Format milliseconds as m:ss or h:mm:ss for transcript timestamps. */
export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}
