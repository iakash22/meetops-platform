import { createApiClient } from './api/client';
import { createHttpAuthClient } from './api/httpAuthClient';
import { createDemoInsightsApi, createHttpInsightsApi } from './api/insightsApi';
import { createDemoMicPermission } from './consent/micPermission';
import { createMockAuthClient } from './auth/mockAuthClient';
import { createDemoSignupApi, type SignupApi } from './auth/SignupApiProvider';
import { createSessionManager } from './auth/sessionManager';
import { createInMemoryTokenStore } from './auth/tokenStore';
import { createDemoConsentApi } from './consent/consentApi';
import { createHttpMeetingsRepository, createHttpTasksRepository } from './data/httpRepositories';
import { createPlaceholderMeetingsRepository } from './data/meetingsRepository';
import type { Repositories } from './data/RepositoriesProvider';
import { createPlaceholderTasksRepository } from './data/tasksRepository';
import { createDemoTaskReviewApi, createHttpTaskReviewApi } from './tasks/reviewApi';
import { createSimulatedCapture } from './record/simulatedRecorder';
import { createMemoryQueueStore, createSimulatedUploadApi } from './upload/simulatedUploadApi';
import { createUploadQueueEngine } from './upload/uploadQueueEngine';

/**
 * App composition root.
 *
 * Live mode: set `EXPO_PUBLIC_API_URL` (https origin, public, not a secret). Auth, signup, meetings and tasks then go
 * to the API with bearer tokens (see `src/api/httpAuthClient.ts` for the mobile token routes Backend must ship).
 * Demo mode (no URL, or a non-https URL outside dev): typed mocks, nothing leaves the device.
 * Still mocked in both modes: consent (no Backend consent route), recorder (SIMULATED: no audio, placeholder chunks into the
 * real upload queue engine with a simulated upload API, in-memory queue, always online),
 * token storage (in memory until `expo-secure-store` lands in a lockfile-owning PR).
 */
export function resolveApiBaseUrl(raw: string | undefined, dev: boolean): string | null {
  const url = raw?.trim().replace(/\/+$/, '');
  if (!url) return null;
  if (url.startsWith('https://')) return url;
  if (dev && /^http:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)(:\d+)?$/.test(url)) return url;
  return null;
}

const API_BASE_URL = resolveApiBaseUrl(
  process.env.EXPO_PUBLIC_API_URL,
  typeof __DEV__ !== 'undefined' && __DEV__,
);

export const IS_DEMO_MODE: boolean = API_BASE_URL === null;

export const sessionManager = createSessionManager({
  client: API_BASE_URL
    ? createHttpAuthClient({ baseUrl: API_BASE_URL })
    : createMockAuthClient({ acceptAnyCredentials: true, latencyMs: 300 }),
  store: createInMemoryTokenStore(),
});

/** Same signature as `ApiClient['signup']` (`POST /auth/signup`, 202, no session). */
export const signupApi: SignupApi = API_BASE_URL
  ? { signup: (body) => createApiClient({ baseUrl: API_BASE_URL }).signup(body) }
  : createDemoSignupApi({ latencyMs: 300 });

const http = API_BASE_URL
  ? { baseUrl: API_BASE_URL, getAccessToken: () => sessionManager.getAccessToken() }
  : null;

const capture = createSimulatedCapture();
const engine = createUploadQueueEngine({
  store: createMemoryQueueStore(),
  chunks: capture,
  api: createSimulatedUploadApi(300),
  network: { isOnline: () => true },
});

export const repositories: Repositories = {
  meetings: http ? createHttpMeetingsRepository(http) : createPlaceholderMeetingsRepository(400),
  tasks: http ? createHttpTasksRepository(http) : createPlaceholderTasksRepository(400),
  insights: http ? createHttpInsightsApi(http) : createDemoInsightsApi(),
  review: http ? createHttpTaskReviewApi(http) : createDemoTaskReviewApi(),
  uploadQueue: engine,
  recordings: {
    engine,
    capture,
    organizationId: () => {
      const state = sessionManager.getState();
      return state.status === 'signedIn' ? state.identity.organizationId : null;
    },
  },
  consent: createDemoConsentApi({ latencyMs: 300 }),
  micPermission: createDemoMicPermission(),
};
