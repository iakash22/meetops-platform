import type { CalendarConnection, CalendarProviderId } from '@meetops/contracts';

export type CalendarSecrets = {
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
};

export type CalendarConnectionUpsert = {
  userId: string;
  provider: CalendarProviderId;
  displayName: string;
  externalAccountId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
};

/**
 * Per-user calendar connections. Every method is scoped by organizationId (forced RLS in Prisma) AND userId: a
 * member never sees or uses another member's connection; other users' ids look the same as unknown ones.
 */
export interface CalendarConnectionsRepository {
  /** The user's non-revoked connections first, newest first. */
  listForUser(organizationId: string, userId: string): Promise<CalendarConnection[]>;
  /** Connect or reconnect (same provider + account keeps the id, reactivates it, replaces tokens). */
  upsert(organizationId: string, input: CalendarConnectionUpsert): Promise<CalendarConnection>;
  /** Active connection secrets, or null for unknown / other-user / revoked ids. */
  readSecrets(organizationId: string, userId: string, id: string): Promise<CalendarSecrets | null>;
  updateTokens(
    organizationId: string,
    id: string,
    t: { accessToken: string; refreshToken: string; accessTokenExpiresAt: Date },
  ): Promise<void>;
  markError(organizationId: string, id: string): Promise<void>;
  /** Soft revoke that wipes tokens. false when unknown / other-user / already revoked. */
  revoke(organizationId: string, userId: string, id: string): Promise<boolean>;
}
