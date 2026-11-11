import type { PublicUser } from '../../users/domain/user.js';
import { toUserDto } from '../../users/http/mappers.js';
import type { OrganizationService } from '../../organizations/application/organization.service.js';
import { toMembershipDto, toOrganizationDto } from '../../organizations/http/mappers.js';
import { stepUpExpiresAt, toSessionAuthLevel, type Session } from '../domain/session.js';
import type { GetSessionResponseT } from './schemas.js';
import { mfaPending } from './security.js';

/** ADR-021: `AuthSession.session` (assurance info). */
export function toSessionInfo(ctx: { session: Session; mfaEnabled?: boolean }) {
  const until = stepUpExpiresAt(ctx.session);
  return {
    authLevel: toSessionAuthLevel(ctx.session.authLevel),
    mfaEnabled: ctx.mfaEnabled === true,
    stepUpExpiresAt: until ? until.toISOString() : null,
  };
}

/**
 * Session → contract session DTO (without csrfToken). Never includes the session token or any hash. ADR-021: while
 * MFA is pending the body is reduced (no organizations, memberships, active org or role) and `mfaRequired` is true.
 */
export async function toSessionResponse(
  ctx: { user: PublicUser; session: Session; mfaEnabled?: boolean },
  orgs: OrganizationService,
): Promise<GetSessionResponseT> {
  if (mfaPending(ctx)) {
    return {
      user: toUserDto(ctx.user),
      organizations: [],
      memberships: [],
      activeOrganizationId: null,
      role: null,
      expiresAt: ctx.session.expiresAt.toISOString(),
      mfaRequired: true,
      session: toSessionInfo(ctx),
    };
  }
  const memberships = await orgs.membershipsForUser(ctx.user.id);
  const active = memberships.find((m) => m.organization.id === ctx.session.activeOrganizationId);
  return {
    user: toUserDto(ctx.user),
    organizations: memberships.map((m) => toOrganizationDto(m.organization)),
    memberships: memberships.map((m) => toMembershipDto(m.membership)),
    activeOrganizationId: active ? active.organization.id : null,
    role: active ? active.membership.role : null,
    expiresAt: ctx.session.expiresAt.toISOString(),
    session: toSessionInfo(ctx),
  };
}
