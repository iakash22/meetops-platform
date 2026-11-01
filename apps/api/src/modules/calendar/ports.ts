import type { CalendarConnection, CalendarEvent, CalendarProviderId } from '@meetops/contracts';

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
 * Events cached by the worker's calendar background sync (P7). Both calls are scoped by org (forced RLS) AND user;
 * other users' connections look unsynced. `coverage` is the window last fully synced and when.
 */
export interface SyncedCalendarStore {
  coverage(
    organizationId: string,
    userId: string,
    connectionId: string,
  ): Promise<{ from: Date; to: Date; lastSyncedAt: Date } | null>;
  listEvents(
    organizationId: string,
    userId: string,
    connectionId: string,
    from: Date,
    to: Date,
  ): Promise<Omit<CalendarEvent, 'provider'>[]>;
}

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
