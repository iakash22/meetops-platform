import { createApiClient, type ApiClientOptions } from './client';
import { createMeetingInsightsApi, type MeetingInsightsApi } from './paths';

/** Transcript/report reads (#212) over HTTP with the mobile Bearer. */
export function createHttpInsightsApi(options: ApiClientOptions): MeetingInsightsApi {
  const { request } = createApiClient(options);
  return createMeetingInsightsApi((path) => request('GET', path));
}
