import { createMeetingInsightsApi, type MeetingInsightsApi } from '@/lib/api-paths';
import type { Invoke } from '@/features/recording/native-upload-api';

/** Transcript/report reads (#212) through the Rust `api_request` command, so the bearer never reaches the webview. */
export function createNativeInsightsApi(invoke: Invoke): MeetingInsightsApi {
  return createMeetingInsightsApi((path) => invoke('api_request', { method: 'GET', path }));
}
