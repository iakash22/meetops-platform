import type { PublicUser } from '../../users/domain/user.js';
import { toUserDto } from '../../users/http/mappers.js';
import type { OrganizationService } from '../../organizations/application/organization.service.js';
import { toMembershipDto, toOrganizationDto } from '../../organizations/http/mappers.js';
import type { Session } from '../domain/session.js';
import type { GetSessionResponseT } from './schemas.js';

/** Session → contract session DTO (without csrfToken). Never includes the session token or any hash. */
export async function toSessionResponse(
  ctx: { user: PublicUser; session: Session },
  orgs: OrganizationService
): Promise<GetSessionResponseT> {
  const memberships = await orgs.membershipsForUser(ctx.user.id);
  const active = memberships.find((m) => m.organization.id === ctx.session.activeOrganizationId);
  return {
    user: toUserDto(ctx.user),
    organizations: memberships.map((m) => toOrganizationDto(m.organization)),
    memberships: memberships.map((m) => toMembershipDto(m.membership)),
    activeOrganizationId: active ? active.organization.id : null,
    role: active ? active.membership.role : null,
    expiresAt: ctx.session.expiresAt.toISOString()
  };
}
