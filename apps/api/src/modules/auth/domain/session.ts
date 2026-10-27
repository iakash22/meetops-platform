import type { UserId } from '../../users/domain/user.js';

export interface Session {
  id: string;
  userId: UserId;
  /** SHA-256 of the opaque session token. The raw token is never stored. */
  tokenHash: string;
  activeOrganizationId: string | null;
  createdAt: Date;
  lastSeenAt: Date;
  /** Absolute expiry (createdAt + absolute timeout). */
  expiresAt: Date;
  revokedAt: Date | null;
  ip: string | null;
  userAgent: string | null;
}

export interface SessionPolicy {
  idleTimeoutMs: number;
  absoluteTimeoutMs: number;
}

export function isSessionActive(session: Session, now: Date, policy: SessionPolicy): boolean {
  if (session.revokedAt !== null) return false;
  if (session.expiresAt.getTime() <= now.getTime()) return false;
  return now.getTime() - session.lastSeenAt.getTime() < policy.idleTimeoutMs;
}

export interface SessionRepository {
  create(session: Session): Promise<Session>;
  findByTokenHash(tokenHash: string): Promise<Session | null>;
  findById(id: string): Promise<Session | null>;
  /** Not revoked and not past the absolute expiry (idle filtering is done by the caller). */
  listActiveForUser(userId: string, now: Date): Promise<Session[]>;
  touch(id: string, at: Date): Promise<void>;
  revoke(id: string, at: Date): Promise<void>;
  revokeAllForUser(userId: string, at: Date): Promise<void>;
  /**
   * Active org of the user's most recently used session (any state, revoked or expired included), or null. Used only to
   * pick the default org at login; the caller re-checks the membership.
   */
  findLastActiveOrganizationId(userId: string): Promise<string | null>;
}
