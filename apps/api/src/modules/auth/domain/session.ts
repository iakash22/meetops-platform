import type { UserId } from '../../users/domain/user.js';
import type { GeoFields } from '../../../shared/geoip/provider.js';
import type { NewLocationOutboxEvent } from '../application/new-location.js';

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
  /** ADR-014 coarse GeoIP of `ip` (all null for private/unknown IPs). Optional for older fakes. */
  geo?: GeoFields;
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
  /**
   * ADR-014: distinct (countryCode, region) of the user's earlier sessions (any state, until purged). Omitted: no
   * new-location alerts.
   */
  knownLocations?(userId: string): Promise<{ countryCode: string; region: string | null }[]>;
  /**
   * ADR-014: create the session and, when given, the `auth.new_location_signin` outbox row in ONE transaction (the
   * outbox insert runs in the event's organization context, forced RLS).
   */
  createWithOutbox?(session: Session, event: NewLocationOutboxEvent): Promise<Session>;
  /** ADR-014: the session's client IP changed; store the new IP and its coarse geo. */
  updateIp?(id: string, ip: string | null, geo: GeoFields): Promise<void>;
  revoke(id: string, at: Date): Promise<void>;
  revokeAllForUser(userId: string, at: Date): Promise<void>;
  /**
   * Active org of the user's most recently used session (any state, revoked or expired included), or null. Used only to
   * pick the default org at login; the caller re-checks the membership.
   */
  findLastActiveOrganizationId(userId: string): Promise<string | null>;
}
