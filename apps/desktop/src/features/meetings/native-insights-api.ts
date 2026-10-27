import { AuthError } from '@/features/auth/auth-client';
import { invokeTokenFree, type Invoke } from '@/lib/native-auth';
import { createMeetingInsightsApi, type MeetingInsightsApi } from '@/lib/api-paths';

/** Transcript/report reads (#212) through the Rust `api_request` command, so the bearer never reaches the webview. */
export function createNativeInsightsApi(invoke: Invoke): MeetingInsightsApi {
  return createMeetingInsightsApi((path) =>
    invokeTokenFree(invoke, 'api_request', { method: 'GET', path }),
  );
}

/** Sample mode has no transcripts or reports: every read answers like the API's 404 ("not ready yet"). */
export function createSampleInsightsApi(): MeetingInsightsApi {
  const notReady = () => Promise.reject(new AuthError('NOT_FOUND', 'Not ready yet.'));
  return { transcript: notReady, report: notReady };
}

export const isNotReady = (e: unknown) => e instanceof AuthError && e.code === 'NOT_FOUND';
