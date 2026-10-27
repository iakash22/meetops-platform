import type { Id, Report, Transcript } from '@meetops/contracts';

/**
 * API route templates for the mobile app. Contracts 0.7.0 export no recording-session or meeting-insights path
 * constants, so these mirror the API media module (#197/#206) and meeting-insights module (#212) exactly;
 * __tests__/contract-paths.test.ts pins them.
 */
export const RECORDING_SESSION_ROUTES = {
  init: '/orgs/:organizationId/recording-sessions',
  chunks: '/recording-sessions/:sessionId/chunks',
  complete: '/recording-sessions/:sessionId/complete',
  abort: '/recording-sessions/:sessionId/abort',
} as const;

export const MEETING_INSIGHTS_PATHS = {
  transcript: '/orgs/:organizationId/meetings/:meetingId/transcript',
  report: '/orgs/:organizationId/meetings/:meetingId/report',
} as const;

/** Fills `:param` segments, URL-encoding each value. Throws on a missing param instead of sending a broken path. */
export function fillPath(template: string, params: Record<string, string>): string {
  return template.replace(/:([A-Za-z]+)/g, (_whole, key: string) => {
    const v = params[key];
    if (v === undefined) throw new Error(`Missing path param ${key}`);
    return encodeURIComponent(v);
  });
}

/** Transcript and report reads (#212). The API answers 404 until they exist. */
export type MeetingInsightsApi = {
  transcript: (organizationId: Id, meetingId: Id) => Promise<Transcript>;
  report: (organizationId: Id, meetingId: Id) => Promise<Report>;
};

export function createMeetingInsightsApi(get: <T>(path: string) => Promise<T>): MeetingInsightsApi {
  return {
    transcript: (organizationId, meetingId) =>
      get(fillPath(MEETING_INSIGHTS_PATHS.transcript, { organizationId, meetingId })),
    report: (organizationId, meetingId) =>
      get(fillPath(MEETING_INSIGHTS_PATHS.report, { organizationId, meetingId })),
  };
}
