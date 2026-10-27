import {
  createSessionVerifier,
  type SessionVerifier as SharedSessionVerifier,
  type BearerAudience,
  type ExtensionTokenStore,
  type SessionStore,
  type VerifiedSession,
} from '@meetops/session-verifier';
import type { Clock } from '../../../shared/ports.js';
import type { UserRepository } from '../../users/domain/user.repository.js';
import type { MembershipRepository } from '../../organizations/domain/repositories.js';
import type { SessionPolicy, SessionRepository } from '../domain/session.js';
import { isUuid, type MeetingRepository } from '../../meetings/domain/meeting.js';

export type { VerifiedSession };

export interface SessionVerifierDeps {
  sessions: SessionRepository;
  users: UserRepository;
  memberships: MembershipRepository;
  clock: Clock;
  sessionPolicy: SessionPolicy;
  /** Org-scoped meeting lookup for canAccessMeeting (realtime `meeting:join`). */
  meetings: MeetingRepository;
  /** ADR-005 extension token store; omitted, every bearer fails closed. */
  extensionTokenStore?: ExtensionTokenStore;
  /** Bearer audiences accepted; default ['extension']. 'desktop' only when DESKTOP_AUTH_ENABLED (ADR-012). */
  bearerAudiences?: readonly BearerAudience[];
}

/**
 * Maps the API's repositories onto the shared SessionStore. The API session row keeps the absolute
 * expiry in `expiresAt` and slides `lastSeenAt`; idle expiry is lastSeenAt + policy idle timeout.
 * A missing user is treated as deleted (fails closed).
 */
export function apiSessionStore(d: SessionVerifierDeps): SessionStore {
  return {
    async findSessionByTokenHash(tokenHash) {
      const s = await d.sessions.findByTokenHash(tokenHash);
      if (!s) return null;
      const user = await d.users.findById(s.userId);
      return {
        id: s.id,
        userId: s.userId,
        activeOrganizationId: s.activeOrganizationId,
        idleExpiresAt: new Date(s.lastSeenAt.getTime() + d.sessionPolicy.idleTimeoutMs),
        absoluteExpiresAt: s.expiresAt,
        lastSeenAt: s.lastSeenAt,
        revokedAt: s.revokedAt,
        userDeletedAt: user ? user.deletedAt : new Date(0),
      };
    },
    async findMembership(organizationId, userId) {
      const m = await d.memberships.find(organizationId, userId);
      return m ? { role: m.role, deletedAt: m.deletedAt } : null;
    },
  };
}

/**
 * Thin adapter over @meetops/session-verifier (ADR-011), which owns the verification rules. Same
 * rules as HTTP (idle + absolute timeouts, revocation, live membership) but read-only: it never
 * slides last_seen_at. Returns null for any credential problem.
 */
export class SessionVerifier {
  private readonly inner: SharedSessionVerifier;
  private readonly meetings: MeetingRepository;

  constructor(deps: SessionVerifierDeps) {
    this.meetings = deps.meetings;
    this.inner = createSessionVerifier({
      sessions: apiSessionStore(deps),
      clock: deps.clock,
      idleTimeoutMs: deps.sessionPolicy.idleTimeoutMs,
      ...(deps.extensionTokenStore ? { extensionTokens: deps.extensionTokenStore } : {}),
      ...(deps.bearerAudiences ? { bearerAudiences: deps.bearerAudiences } : {}),
    });
  }

  verify(sessionToken: string | undefined): Promise<VerifiedSession | null> {
    if (!sessionToken) return Promise.resolve(null);
    return this.inner.verifySession({ cookie: sessionToken });
  }

  /** ADR-005 bearer: audience, expiry, family revocation and live membership. Null on any problem. */
  verifyBearer(token: string | undefined): Promise<VerifiedSession | null> {
    if (!token) return Promise.resolve(null);
    return this.inner.verifySession({ bearer: token });
  }

  verifyByHash(cookieHash: string): Promise<VerifiedSession | null> {
    return this.inner.verifySessionByHash({ cookieHash });
  }

  /**
   * True only when the meeting exists, is not soft-deleted and belongs to the session's verified active
   * organization (the lookup runs in that org's RLS context). Missing, deleted, other-org and malformed ids are
   * all `false`, the same answer, so a caller cannot probe other tenants. Errors fail closed.
   */
  async canAccessMeeting(session: VerifiedSession, meetingId: string): Promise<boolean> {
    if (!session.organizationId || !isUuid(meetingId)) return false;
    try {
      const m = await this.meetings.findById(session.organizationId, meetingId);
      return m !== null && m.organizationId === session.organizationId;
    } catch {
      return false;
    }
  }
}
