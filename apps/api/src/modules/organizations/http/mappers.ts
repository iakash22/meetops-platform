import type {
  Membership as MembershipDto,
  Organization as OrganizationDto,
  OrganizationMember as OrganizationMemberDto,
  UserSummary,
} from '@meetops/contracts';
import type { Organization } from '../domain/organization.js';
import type { Membership, Role } from '../domain/membership.js';
import type { Invitation } from '../domain/invitation.js';

export const toOrganizationDto = (o: Organization): OrganizationDto => ({
  id: o.id,
  name: o.name,
  slug: o.slug,
  createdAt: o.createdAt.toISOString(),
  updatedAt: o.updatedAt.toISOString(),
});

export const toMembershipDto = (m: Membership): MembershipDto => ({
  id: m.id,
  organizationId: m.organizationId,
  userId: m.userId,
  role: m.role,
  createdAt: m.createdAt.toISOString(),
});

/** Never includes tokenHash. */
export const toInvitationDto = (i: Invitation) => ({
  id: i.id,
  organizationId: i.organizationId,
  email: i.email,
  role: i.role,
  status: i.status,
  expiresAt: i.expiresAt.toISOString(),
});

/**
 * Strict OrganizationMember. `email` only for owner/admin viewers (contracts RBAC rule); for member/viewer the key
 * is omitted, never null. Optional fields are omitted when empty.
 */
export const toOrganizationMemberDto = (
  m: Membership,
  user: { id: string; email: string; name: string | null } | null,
  viewerRole: Role,
): OrganizationMemberDto => {
  const summary: UserSummary = { id: m.userId };
  if (user && (viewerRole === 'owner' || viewerRole === 'admin')) summary.email = user.email;
  if (user?.name) summary.name = user.name.slice(0, 200);
  return { ...toMembershipDto(m), user: summary };
};
