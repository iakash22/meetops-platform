import type { Role } from '../../../shared/contracts/index.js';
import type { PublicUser } from '../../users/domain/user.js';
import type { MembershipRepository } from '../../organizations/domain/repositories.js';
import type { AuthService } from './auth.service.js';

export interface VerifiedSession {
  user: PublicUser;
  organizationId: string | null;
  role: Role | null;
}

/**
 * For apps/realtime: resolves a raw session cookie value to { user, organizationId, role }.
 * Applies the same idle/absolute timeouts as HTTP. Throws UnauthenticatedError on failure.
 */
export class SessionVerifier {
  constructor(
    private readonly auth: AuthService,
    private readonly memberships: MembershipRepository
  ) {}

  async verify(sessionToken: string | undefined): Promise<VerifiedSession> {
    const { user, session } = await this.auth.authenticate(sessionToken);
    const organizationId = session.activeOrganizationId;
    const m = organizationId ? await this.memberships.find(organizationId, user.id) : null;
    return { user, organizationId: m ? organizationId : null, role: m?.role ?? null };
  }

  /** TODO(meetings): real check once the meetings module exists. Fails closed. */
  async canAccessMeeting(session: VerifiedSession, meetingId: string): Promise<boolean> {
    void session;
    void meetingId;
    return false;
  }
}
