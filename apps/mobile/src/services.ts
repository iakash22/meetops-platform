import { createMockAuthClient } from './auth/mockAuthClient';
import { createSessionManager } from './auth/sessionManager';
import { createInMemoryTokenStore } from './auth/tokenStore';
import { createPlaceholderMeetingsRepository } from './data/meetingsRepository';
import type { Repositories } from './data/RepositoriesProvider';
import { createPlaceholderTasksRepository } from './data/tasksRepository';
import { createPlaceholderUploadQueue } from './data/uploadQueue';

/**
 * App composition root. Everything here is a MOCK until the mobile bearer ADR and Backend routes land:
 * - auth: demo mode, any well-formed email/password signs in, nothing leaves the device;
 * - tokens: in memory only (expo-secure-store follow-up);
 * - meetings and tasks: placeholder lists (no list routes in the API yet);
 * - upload queue: placeholder, always empty (no native recording yet).
 * Swap implementations here; screens depend only on the interfaces.
 */
export const IS_DEMO_MODE = true as const;

export const sessionManager = createSessionManager({
  client: createMockAuthClient({ acceptAnyCredentials: true, latencyMs: 300 }),
  store: createInMemoryTokenStore(),
});

export const repositories: Repositories = {
  meetings: createPlaceholderMeetingsRepository(400),
  tasks: createPlaceholderTasksRepository(400),
  uploadQueue: createPlaceholderUploadQueue(),
};
