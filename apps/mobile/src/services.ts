import { createMockAuthClient } from './auth/mockAuthClient';
import { createDemoSignupApi, type SignupApi } from './auth/SignupApiProvider';
import { createSessionManager } from './auth/sessionManager';
import { createInMemoryTokenStore } from './auth/tokenStore';
import { createDemoConsentApi } from './consent/consentApi';
import { createPlaceholderMeetingsRepository } from './data/meetingsRepository';
import type { Repositories } from './data/RepositoriesProvider';
import { createPlaceholderTasksRepository } from './data/tasksRepository';
import { createPlaceholderUploadQueue } from './data/uploadQueue';

/**
 * App composition root. Everything here is a MOCK until the mobile bearer ADR and Backend routes land:
 * - auth: demo mode, any well-formed email/password signs in, nothing leaves the device;
 * - signup: demo stand-in for `ApiClient.signup` (swap for `createApiClient({ baseUrl }).signup` once wired);
 * - tokens: in memory only (expo-secure-store follow-up);
 * - meetings and tasks: placeholder lists (no list routes in the API yet);
 * - upload queue: placeholder, always empty (no native recording yet);
 * - consent: demo, in memory (no Backend consent API yet). Opt-in starts OFF.
 * Swap implementations here; screens depend only on the interfaces.
 */
export const IS_DEMO_MODE = true as const;

export const sessionManager = createSessionManager({
  client: createMockAuthClient({ acceptAnyCredentials: true, latencyMs: 300 }),
  store: createInMemoryTokenStore(),
});

/** Same signature as `ApiClient['signup']` (`POST /auth/signup`, 202, no session). */
export const signupApi: SignupApi = createDemoSignupApi({ latencyMs: 300 });

export const repositories: Repositories = {
  meetings: createPlaceholderMeetingsRepository(400),
  tasks: createPlaceholderTasksRepository(400),
  uploadQueue: createPlaceholderUploadQueue(),
  consent: createDemoConsentApi({ latencyMs: 300 }),
};
