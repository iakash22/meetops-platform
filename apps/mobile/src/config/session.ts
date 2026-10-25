/**
 * Placeholder session shape for the mobile app. The real shape comes from
 * Backend's auth contract; until then this is a local stub.
 * Always use `organizationId` (never orgId/tenantId).
 */
export interface MobileSession {
  userId: string;
  organizationId: string;
}

export const RECORDING_ENABLED = false as const;
