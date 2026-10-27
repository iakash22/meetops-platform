import { ApiError, createApiClient, type ApiClientOptions } from './client';
import { createMeetingInsightsApi, type MeetingInsightsApi } from './paths';

/** Transcript/report reads (#212) over HTTP with the mobile Bearer. */
export function createHttpInsightsApi(options: ApiClientOptions): MeetingInsightsApi {
  const { request } = createApiClient(options);
  return createMeetingInsightsApi((path) => request('GET', path));
}

/** Demo mode has no transcripts or reports: every read answers like the API's 404 ("not ready yet"). */
export function createDemoInsightsApi(): MeetingInsightsApi {
  const notReady = () => Promise.reject(new ApiError(404, 'NOT_FOUND', 'Not ready yet.'));
  return { transcript: notReady, report: notReady };
}
