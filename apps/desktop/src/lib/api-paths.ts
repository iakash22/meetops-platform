import type { Id, Report, Transcript } from '@meetops/contracts';
import { MEETING_INSIGHTS_PATHS, RECORDING_SESSION_PATHS } from '@meetops/contracts/types';

/**
 * API route templates for the desktop app, from @meetops/contracts 0.8.0 (RECORDING_SESSION_PATHS and
 * MEETING_INSIGHTS_PATHS). RECORDING_SESSION_ROUTES is kept as the local alias; test/contract-paths.test.ts pins both.
 */
export const RECORDING_SESSION_ROUTES = RECORDING_SESSION_PATHS;

export { MEETING_INSIGHTS_PATHS };

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
