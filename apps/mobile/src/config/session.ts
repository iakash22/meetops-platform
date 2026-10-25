/**
 * Minimal signed-in identity used across the app. Derived from the contracts session
 * (`GetAuthSessionResponse`) by `toIdentity` in `src/auth/sessionManager.ts`.
 * Always use `organizationId` (never orgId/tenantId).
 */
export interface MobileSession {
  userId: string;
  organizationId: string;
}

export const RECORDING_ENABLED = false as const;
