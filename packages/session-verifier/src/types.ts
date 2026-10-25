import type { Role } from '@meetops/contracts';

/** ADR-011 section 2.2. Exactly one credential. */
export type VerifyInput = { cookie: string } | { bearer: string };
/** ADR-011 section 5.3: re-verify from the stored credential hash, never the raw value. */
export type VerifyByHashInput = { cookieHash: string } | { bearerHash: string };

export type CredentialKind = 'session' | 'extension';

export interface VerifiedSession {
  userId: string;
  /** Active org; only returned while the membership is live. */
  organizationId: string;
  /** sessions.id, or the extension token family id for bearers. */
  sessionId: string;
  credential: CredentialKind;
  /** The membership role in organizationId. */
  role: Role;
  /** Bearer only. */
  scopes?: readonly string[];
  /** The earliest of idle expiry, absolute expiry and token expiry. */
  expiresAt: Date;
}

/** The `sessions` columns the verifier needs (global table, no RLS). */
export interface SessionRecord {
  id: string;
  userId: string;
  activeOrganizationId: string | null;
  /** Idle expiry (sessions.expires_at, slid by HTTP activity). */
  idleExpiresAt: Date;
  /** Hard cap (sessions.absolute_expires_at). */
  absoluteExpiresAt: Date;
  lastSeenAt: Date;
  revokedAt: Date | null;
  /** users.deleted_at of the session's user; a deleted user has no valid session. */
  userDeletedAt: Date | null;
}

export interface MembershipRecord {
  role: Role;
  deletedAt: Date | null;
}

/** Read-only port over sessions and memberships. Never slides last_seen_at. */
export interface SessionStore {
  findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null>;
  /** MUST run under organization context (RLS) for organizationId. */
  findMembership(organizationId: string, userId: string): Promise<MembershipRecord | null>;
}

/** An extension bearer token (ADR-005 A1). */
export interface ExtensionTokenRecord {
  /** Token family id; revoking the family revokes every rotation of it. */
  familyId: string;
  userId: string;
  organizationId: string;
  audience: string;
  scopes: readonly string[];
  expiresAt: Date;
  revokedAt: Date | null;
}

/** Port for the ADR-005 extension token store. Without one, every bearer fails closed (null). */
export interface ExtensionTokenStore {
  findByTokenHash(tokenHash: string): Promise<ExtensionTokenRecord | null>;
}

export interface Clock {
  now(): Date;
}
