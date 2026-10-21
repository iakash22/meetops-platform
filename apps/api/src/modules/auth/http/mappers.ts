import type { PublicUser } from '../../users/domain/user.js';
import { toUserDto } from '../../users/http/mappers.js';
import type { OrganizationService } from '../../organizations/application/organization.service.js';
import { toMembershipDto, toOrganizationDto } from '../../organizations/http/mappers.js';
import type { Session, SessionPolicy } from '../domain/session.js';
import type { SessionResponseT } from './schemas.js';

/** Session → response DTO. Never includes the session token or any hash. */
export async function toSessionResponse(
  ctx: { user: PublicUser; session: Session },
  policy: SessionPolicy,
  orgs: OrganizationService
): Promise<SessionResponseT> {
  const memberships = await orgs.membershipsForUser(ctx.user.id);
  const idle = Math.min(ctx.session.lastSeenAt.getTime() + policy.idleTimeoutMs, ctx.session.expiresAt.getTime());
  return {
    user: toUserDto(ctx.user),
    organizations: memberships.map((m) => toOrganizationDto(m.organization)),
    memberships: memberships.map((m) => toMembershipDto(m.membership)),
    activeOrganizationId: ctx.session.activeOrganizationId,
    expiresAt: ctx.session.expiresAt.toISOString(),
    idleExpiresAt: new Date(idle).toISOString()
  };
}
