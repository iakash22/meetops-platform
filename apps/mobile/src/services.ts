import { createMockAuthClient } from './auth/mockAuthClient';
import { createSessionManager } from './auth/sessionManager';
import { createInMemoryTokenStore } from './auth/tokenStore';
import { createMockMeetingsClient } from './meetings/meetingsClient';

/**
 * App composition root. Everything here is a MOCK until the mobile bearer ADR and Backend routes land:
 * - auth: demo mode, any well-formed email/password signs in, nothing leaves the device;
 * - tokens: in memory only (expo-secure-store follow-up);
 * - meetings: static placeholder list (no list-meetings route in the API yet).
 * Swap implementations here; screens depend only on the interfaces.
 */
export const IS_DEMO_MODE = true as const;

export const sessionManager = createSessionManager({
  client: createMockAuthClient({ acceptAnyCredentials: true, latencyMs: 300 }),
  store: createInMemoryTokenStore(),
});

export const meetingsClient = createMockMeetingsClient();
