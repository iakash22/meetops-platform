import type { CalendarConnection, CalendarEvent, CalendarProviderId } from '@meetops/contracts';

export type CalendarSecrets = {
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date | null;
  /** Token-write generation read with these secrets (compare-and-set for updateTokens). */
  tokenGeneration?: number;
  /** AAD context version of the stored refresh token (1 = pre-v2, 2 = per-field). */
  refreshEncVersion?: 1 | 2 | null;
};

/** updateTokens fencing: `generation` = compare-and-set on the value readSecrets returned. */
export type CalendarTokenWriteOptions = {
  generation?: number | undefined;
  refreshEncVersion?: 1 | 2 | null | undefined;
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
    /** With `generation`, writes only while the token generation is unchanged (an empty refresh keeps the stored one). */
    opts?: CalendarTokenWriteOptions,
  ): Promise<boolean | void>;
  markError(organizationId: string, id: string): Promise<void>;
  /**
   * True when `revoke` also deletes the connection's event -> meeting links in the same transaction (all or
   * nothing), so the service need not clean them up separately.
   */
  readonly revokesLinks?: boolean;
  /** Soft revoke that wipes tokens. false when unknown / other-user / already revoked. */
  revoke(organizationId: string, userId: string, id: string): Promise<boolean>;
}

export type CalendarEventLinkRow = {
  connectionId: string;
  eventId: string;
  meetingId: string;
  createdAt: Date;
  updatedAt: Date;
};

/**
 * Calendar event -> meeting links (P7). Scoped by organizationId (forced RLS in Prisma) AND userId. The service checks
 * that the connection is the caller's own and not revoked before writing; the repository checks the meeting is a live
 * (not soft-deleted) meeting of the same organization. Links to soft-deleted meetings are never returned.
 */
export interface CalendarEventLinksRepository {
  listForUser(
    organizationId: string,
    userId: string,
    connectionIds: string[],
  ): Promise<CalendarEventLinkRow[]>;
  /** Live meetings by external call id. Ids matched by more than one meeting are left out (ambiguous). */
  matchExternalIds(organizationId: string, externalIds: string[]): Promise<Map<string, string>>;
  /** Link or re-link. null when the meeting is unknown, soft-deleted or in another organization. */
  upsert(
    organizationId: string,
    userId: string,
    link: { connectionId: string; eventId: string; meetingId: string },
  ): Promise<CalendarEventLinkRow | null>;
  /** false when there was no such link of this user. */
  remove(
    organizationId: string,
    userId: string,
    connectionId: string,
    eventId: string,
  ): Promise<boolean>;
  /** Disconnect: drop every link of the connection. */
  removeForConnection(organizationId: string, connectionId: string): Promise<void>;
}
