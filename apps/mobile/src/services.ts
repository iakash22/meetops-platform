import { createApiClient, createApiRequester } from './api/client';
import { Platform } from 'react-native';
import {
  createDemoPushDeviceApi,
  createDemoPushTokenProvider,
  createHttpPushDeviceApi,
  createPushRegistrationService,
  createPushWipeHook,
  type PushRegistrationService,
} from './notifications/pushRegistration';
import { createHttpAuthClient } from './api/httpAuthClient';
import { createDemoInsightsApi, createHttpInsightsApi } from './api/insightsApi';
import { createDemoMicPermission } from './consent/micPermission';
import { createMockAuthClient } from './auth/mockAuthClient';
import { createDemoSignupApi, type SignupApi } from './auth/SignupApiProvider';
import { createSessionManager } from './auth/sessionManager';
import { createSecureTokenStore } from './auth/secureTokenStore';
import { createDeviceIdProvider } from './auth/deviceId';
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
 * Tokens: Keychain / Keystore via expo-secure-store (`AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`: device-only, Android
 * backup disabled). Only the refresh token is persisted; the access token is memory-only. A failed write keeps the
 * rotated pair in memory and retries. A stable per-install `deviceId` (ADR-005) is sent on login, refresh and logout.
 */
export function resolveApiBaseUrl(raw: string | undefined, dev: boolean): string | null {
  const url = raw?.trim().replace(/\/+$/, '');
  if (!url) return null;
  if (url.startsWith('https://')) return url;
  if (dev && /^http:\/\/(localhost|127\.0\.0\.1|10\.0\.2\.2)(:\d+)?$/.test(url)) return url;
  return null;
}

const API_BASE_URL = resolveApiBaseUrl(
  process.env.EXPO_PUBLIC_API_URL as string | undefined,
  typeof __DEV__ !== 'undefined' && __DEV__,
);

export const IS_DEMO_MODE: boolean = API_BASE_URL === null;

const deviceIds = createDeviceIdProvider();

export const sessionManager = createSessionManager({
  client: API_BASE_URL
    ? createHttpAuthClient({
        baseUrl: API_BASE_URL,
        getDeviceId: () => deviceIds.get(),
      })
    : createMockAuthClient({ acceptAnyCredentials: true, latencyMs: 300 }),
  store: createSecureTokenStore(),
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

/**
 * One push registration service per signed-in user, so a new user never sees the previous user's "on" state.
 * Demo mode: simulated OS prompt + in-memory API. Live mode: the real HTTP `/me/push-devices` client, but there is no
 * native token provider yet (`expo-notifications` is not a dependency), so `null` and the card says it's unavailable
 * rather than registering a fake token with a real server.
 */
const pushServices = new Map<string, PushRegistrationService>();
const pushPlatform = Platform.OS === 'ios' ? 'ios' : 'android';

export function pushServiceFor(userId: string): PushRegistrationService | null {
  if (http) return null; // CONTRACT OK, NATIVE GAP: needs an expo-notifications PushTokenProvider.
  let s = pushServices.get(userId);
  if (!s) {
    s = createPushRegistrationService(
      createDemoPushTokenProvider(),
      createDemoPushDeviceApi(),
      pushPlatform,
    );
    pushServices.set(userId, s);
  }
  return s;
}

sessionManager.registerWipeHook(createPushWipeHook(pushServices));

/** Live HTTP client, exported for the native provider follow-up. */
export const httpPushDeviceApi = http ? createHttpPushDeviceApi(createApiRequester(http)) : null;

/** Best-effort: revoke this device's push registration while the session is still valid, then forget it. */
export async function unregisterPushOnSignOut(userId: string | undefined): Promise<void> {
  if (!userId) return;
  const s = pushServices.get(userId);
  pushServices.delete(userId);
  if (s) await s.disable().catch(() => undefined);
}
