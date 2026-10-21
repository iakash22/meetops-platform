import type { UserId } from '../../users/domain/user.js';

export interface Session {
  id: string;
  userId: UserId;
  /** SHA-256 of the opaque token. The raw token is never stored. */
  tokenHash: string;
  activeOrganizationId: string | null;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

export function isSessionActive(session: Session, now: Date): boolean {
  return session.revokedAt === null && session.expiresAt.getTime() > now.getTime();
}

export interface SessionRepository {
  create(session: Session): Promise<Session>;
  findByTokenHash(tokenHash: string): Promise<Session | null>;
  revoke(id: string, at: Date): Promise<void>;
  setActiveOrganization(id: string, organizationId: string | null): Promise<void>;
}
