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
  touch(id: string, at: Date): Promise<void>;
  revoke(id: string, at: Date): Promise<void>;
  revokeAllForUser(userId: string, at: Date): Promise<void>;
}
