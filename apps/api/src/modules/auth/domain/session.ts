import { SESSION_AUTH_LEVELS } from '@meetops/contracts';
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
  /**
   * How the user proved who they are (`sessions.auth_level`). Absent means `password` (the column default) so older
   * fakes keep working. ADR-021: `mfa` once this session passed a TOTP / recovery-code check (only
   * AuthService.elevate writes it).
   */
  authLevel?: SessionAuthLevel;
  /**
   * ADR-021 D4: when this session last proved MFA (`sessions.mfa_at`), the step-up freshness clock. Null/absent: no
   * fresh step-up. A DB CHECK allows it only with `auth_level = 'mfa'`. An org switch keeps the level but clears it.
   */
  mfaAt?: Date | null;
}

/**
 * OIDC review N-4: Google sessions are `google`, not the `password` column default. ADR-021: `mfa` is the elevated
 * level (DB CHECK `sessions_auth_level_check` pins the same three values). Defined once, in @meetops/contracts.
 */
export { SESSION_AUTH_LEVELS };
export type SessionAuthLevel = (typeof SESSION_AUTH_LEVELS)[number];
/** Unknown stored values are never trusted: they read back as the lowest level, `password`. */
export const toSessionAuthLevel = (v: string | null | undefined): SessionAuthLevel =>
  (SESSION_AUTH_LEVELS as readonly string[]).includes(v ?? '')
    ? (v as SessionAuthLevel)
    : 'password';

/** ADR-021 OQ-1 default: a step-up stays fresh for 10 minutes. */
export const STEP_UP_WINDOW_MS = 10 * 60_000;

/** True when the session is MFA-elevated (any time). */
export const isMfaSession = (s: Pick<Session, 'authLevel'>): boolean => s.authLevel === 'mfa';

/** When the current step-up stops being fresh, or null when there is none. */
export function stepUpExpiresAt(s: Pick<Session, 'authLevel' | 'mfaAt'>): Date | null {
  if (!isMfaSession(s) || !s.mfaAt) return null;
  return new Date(s.mfaAt.getTime() + STEP_UP_WINDOW_MS);
}

/** ADR-021 D4 step-up: an `mfa` session whose `mfaAt` is within STEP_UP_WINDOW_MS (and not in the future). */
export function hasFreshStepUp(s: Pick<Session, 'authLevel' | 'mfaAt'>, now: Date): boolean {
  const until = stepUpExpiresAt(s);
  if (!until || !s.mfaAt) return false;
  return s.mfaAt.getTime() <= now.getTime() + 5_000 && now.getTime() < until.getTime();
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
  /** Resolves true when this call revoked a live row (false: already revoked or gone). */
  revoke(id: string, at: Date): Promise<boolean>;
  revokeAllForUser(userId: string, at: Date): Promise<void>;
  /**
   * Active org of the user's most recently used session (any state, revoked or expired included), or null. Used only to
   * pick the default org at login; the caller re-checks the membership.
   */
  findLastActiveOrganizationId(userId: string): Promise<string | null>;
}
