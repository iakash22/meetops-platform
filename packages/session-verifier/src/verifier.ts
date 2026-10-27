import { ROLES, type Role } from '@meetops/contracts';
import { hashToken, TOKEN_HASH_PATTERN } from './hash.js';
import type {
  Clock,
  ExtensionTokenStore,
  SessionStore,
  VerifiedSession,
  VerifyByHashInput,
  VerifyInput,
} from './types.js';

/** apps/api's default idle timeout (30 min). Deployments pass their own SessionPolicy value. */
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
/** ADR-005 A1 extension bearer audience; the default and only audience unless opted in. */
export const EXTENSION_AUDIENCE = 'extension';
/** ADR-012 desktop bearer audience. Accepted only when listed in bearerAudiences. */
export const DESKTOP_AUDIENCE = 'desktop';
export type BearerAudience = typeof EXTENSION_AUDIENCE | typeof DESKTOP_AUDIENCE;
export const BEARER_AUDIENCES: readonly BearerAudience[] = [EXTENSION_AUDIENCE, DESKTOP_AUDIENCE];
/** Longer raw credentials are rejected before hashing. */
export const MAX_CREDENTIAL_LENGTH = 512;

export interface SessionVerifierOptions {
  sessions: SessionStore;
  /** ADR-005 extension token store. Omitted: bearers always return null. */
  extensionTokens?: ExtensionTokenStore;
  clock?: Clock;
  /** Idle timeout applied on top of sessions.expires_at (whichever is earlier wins). */
  idleTimeoutMs?: number;
  /** Bearer audiences accepted. Default ['extension']; 'desktop' is opt-in (ADR-012). */
  bearerAudiences?: readonly BearerAudience[];
}

export interface SessionVerifier {
  verifySession(input: VerifyInput): Promise<VerifiedSession | null>;
  verifySessionByHash(input: VerifyByHashInput): Promise<VerifiedSession | null>;
}

const systemClock: Clock = { now: () => new Date() };
const isRole = (r: unknown): r is Role =>
  typeof r === 'string' && (ROLES as readonly string[]).includes(r);
const minDate = (...ds: Date[]) => new Date(Math.min(...ds.map((d) => d.getTime())));
const usable = (s: unknown): s is string =>
  typeof s === 'string' && s.length > 0 && s.length <= MAX_CREDENTIAL_LENGTH;

/**
 * ADR-011 section 2. Resolves a session cookie or an extension bearer to a VerifiedSession, or null for any
 * credential problem (unknown, expired, idle, revoked, wrong audience, no active org, no live membership).
 * Read-only. Store errors propagate so callers can fail closed and log (section 5.4).
 */
export function createSessionVerifier(opts: SessionVerifierOptions): SessionVerifier {
  const clock = opts.clock ?? systemClock;
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0)
    throw new RangeError('idleTimeoutMs must be > 0');
  const audiences = new Set<string>(opts.bearerAudiences ?? [EXTENSION_AUDIENCE]);
  for (const a of audiences)
    if (!(BEARER_AUDIENCES as readonly string[]).includes(a))
      throw new RangeError(`unknown bearer audience: ${a}`);

  const liveRole = async (organizationId: string, userId: string): Promise<Role | null> => {
    const m = await opts.sessions.findMembership(organizationId, userId);
    if (!m || m.deletedAt !== null || !isRole(m.role)) return null;
    return m.role;
  };

  const bySessionHash = async (tokenHash: string): Promise<VerifiedSession | null> => {
    const s = await opts.sessions.findSessionByTokenHash(tokenHash);
    if (!s || s.revokedAt !== null || s.userDeletedAt !== null || !s.activeOrganizationId)
      return null;
    const now = clock.now().getTime();
    const idle = minDate(s.idleExpiresAt, new Date(s.lastSeenAt.getTime() + idleTimeoutMs));
    const expiresAt = minDate(idle, s.absoluteExpiresAt);
    if (expiresAt.getTime() <= now) return null;
    const role = await liveRole(s.activeOrganizationId, s.userId);
    if (!role) return null;
    return {
      userId: s.userId,
      organizationId: s.activeOrganizationId,
      sessionId: s.id,
      credential: 'session',
      role,
      expiresAt,
    };
  };

  const byBearerHash = async (tokenHash: string): Promise<VerifiedSession | null> => {
    if (!opts.extensionTokens) return null;
    const t = await opts.extensionTokens.findByTokenHash(tokenHash);
    if (!t || !audiences.has(t.audience) || t.revokedAt !== null) return null;
    if (t.expiresAt.getTime() <= clock.now().getTime()) return null;
    const role = await liveRole(t.organizationId, t.userId);
    if (!role) return null;
    return {
      userId: t.userId,
      organizationId: t.organizationId,
      sessionId: t.familyId,
      credential: t.audience === DESKTOP_AUDIENCE ? 'desktop' : 'extension',
      role,
      scopes: [...t.scopes],
      expiresAt: t.expiresAt,
    };
  };

  return {
    async verifySession(input) {
      if ('cookie' in input)
        return usable(input.cookie) ? bySessionHash(hashToken(input.cookie)) : null;
      if ('bearer' in input)
        return usable(input.bearer) ? byBearerHash(hashToken(input.bearer)) : null;
      return null;
    },
    async verifySessionByHash(input) {
      if ('cookieHash' in input)
        return TOKEN_HASH_PATTERN.test(input.cookieHash) ? bySessionHash(input.cookieHash) : null;
      if ('bearerHash' in input)
        return TOKEN_HASH_PATTERN.test(input.bearerHash) ? byBearerHash(input.bearerHash) : null;
      return null;
    },
  };
}
