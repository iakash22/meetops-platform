import { createApiClient, createApiRequester } from './api/client';
import { AppState, Platform } from 'react-native';
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
import { createDemoMeetingResolver, createHttpMeetingResolver } from './consent/meetingResolver';
import { createHttpMeetingsRepository, createHttpTasksRepository } from './data/httpRepositories';
import { createPlaceholderMeetingsRepository } from './data/meetingsRepository';
import type { Repositories } from './data/RepositoriesProvider';
import { createPlaceholderTasksRepository } from './data/tasksRepository';
import { createDemoTaskReviewApi, createHttpTaskReviewApi } from './tasks/reviewApi';
import type { RecordingCapture } from './record/capture';
import {
  createAndroidForegroundIndicator,
  createExpoAudioDriver,
  createNativeMicPermission,
  expoFileSystem,
  createNativeChunkCipher,
  iosBackupExclusion,
  recorderFileGuard,
} from './record/expoAudio';
import { withBackupExclusion } from './record/backupExclusion';
import { createFileChunkStore } from './record/fileChunkStore';
import { createNativeCapture } from './record/nativeCapture';
import { createSimulatedCapture } from './record/simulatedRecorder';
import { createHttpRecordingUploadApi } from './upload/httpRecordingUploadApi';
import { createMemoryQueueStore, createSimulatedUploadApi } from './upload/simulatedUploadApi';
import { createFileQueueStore } from './upload/fileQueueStore';
import { createUploadQueueEngine } from './upload/uploadQueueEngine';
import { reconcileOrphans, startUploadScheduler } from './upload/uploadScheduler';
import { createNetInfoStatus, loadNetInfo } from './upload/netInfoStatus';

/**
 * App composition root.
 *
 * Live mode: set `EXPO_PUBLIC_API_URL` (https origin, public, not a secret). Auth, signup, meetings and tasks then go
 * to the API with bearer tokens (see `src/api/httpAuthClient.ts` for the mobile token routes Backend must ship).
 * Demo mode (no URL, or a non-https URL outside dev): typed mocks, nothing leaves the device.
 * Recording: demo mode uses the SIMULATED capture (no audio, placeholder chunks) and a simulated upload API. Live mode
 * uses the native expo-audio capture (M4) with real mic permission, chunk files in the app sandbox, and the HTTP
 * recording-session upload API. Consent opt-in stays device-local (no Backend consent route; the attestation travels
 * with the upload, contracts G11).
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

// R4 (iOS): the recordings folder is excluded from iCloud/Finder backups before anything is written to it.
const excludeFromBackup = http ? iosBackupExclusion() : null;
const fileSystem = http
  ? excludeFromBackup
    ? withBackupExclusion(expoFileSystem(), excludeFromBackup)
    : expoFileSystem()
  : null;
// R5: chunk files are AES-256-GCM sealed (Android Keystore / iOS Keychain). Fails closed without the native module.
const chunkCipher = fileSystem ? createNativeChunkCipher() : null;
const chunkFiles = fileSystem && chunkCipher ? createFileChunkStore(fileSystem, chunkCipher) : null;
const nativeCapture = chunkFiles
  ? createNativeCapture(createExpoAudioDriver(), chunkFiles, createAndroidForegroundIndicator(), {
      recorderFiles: recorderFileGuard(),
    })
  : null;
const capture: RecordingCapture = nativeCapture ?? createSimulatedCapture();
const networkStatus = http ? createNetInfoStatus(loadNetInfo()) : null;
const engine = createUploadQueueEngine({
  // Live: durable queue file in the sandbox (M5). Demo: in memory.
  store: fileSystem ? createFileQueueStore(fileSystem) : createMemoryQueueStore(),
  chunks: capture,
  api: http ? createHttpRecordingUploadApi(http) : createSimulatedUploadApi(300),
  // Live: NetInfo pauses passes while offline (no attempt is used up); a failed request still backs off
  // (5 s to 15 min). Demo: always online.
  network: networkStatus ?? { isOnline: () => true },
});
if (chunkFiles) {
  // R7: after a crash or kill, unfinalized recorder output is discarded and capture never resumes; a recording whose
  // sealing was interrupted is sealed and enqueued. Runs before the orphan pass (which would delete its chunks), and
  // `begin` awaits it so the cache sweep can never race a live recorder file.
  void (
    nativeCapture?.recoverOnLaunch(async (r) => {
      // Idempotent: a kill after enqueue but before the marker cleared must not queue it twice.
      if (!(await engine.items()).some((i) => i.id === r.id)) await engine.enqueue(r);
    }) ?? Promise.resolve()
  )
    .catch(() => undefined)
    .then(() => reconcileOrphans(engine, chunkFiles))
    .catch(() => undefined)
    // Chunks saved in plaintext by an older build are re-sealed before any upload pass reads them.
    .then(() => chunkFiles.migrateLegacy())
    .catch(() => undefined)
    .then(() => startUploadScheduler(engine, AppState, undefined, networkStatus ?? undefined));
}
// R4 + R7: logout and organization switch stop any capture and wipe every local recording.
sessionManager.registerWipeHook(async () => {
  await capture.abort();
  let incomplete: unknown = null;
  await engine.wipe().catch((e: unknown) => {
    incomplete = e;
  });
  // Sweep every folder (including ones the engine couldn't delete). Anything still left is an orphan with no queue
  // entry, which `reconcileOrphans` deletes at the next launch, so a failed delete is retried rather than forgotten.
  if (chunkFiles)
    for (const id of await chunkFiles.list()) await chunkFiles.remove(id).catch(() => undefined);
  await chunkFiles?.setHeld([]).catch(() => undefined);
  // Before the re-throw: anything a failed delete left behind becomes unreadable (the next capture gets a new key).
  await chunkCipher?.deleteKey().catch(() => undefined);
  if (incomplete)
    throw incomplete instanceof Error ? incomplete : new Error('Local wipe incomplete.');
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
  meetingResolver: http
    ? createHttpMeetingResolver(createApiRequester(http))
    : createDemoMeetingResolver(),
  micPermission: http ? createNativeMicPermission() : createDemoMicPermission(),
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
