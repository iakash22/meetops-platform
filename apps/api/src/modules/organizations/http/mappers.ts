import type {
  Membership as MembershipDto,
  Organization as OrganizationDto
} from '@meetops/contracts';
import type { Organization } from '../domain/organization.js';
import type { Membership } from '../domain/membership.js';
import type { Invitation } from '../domain/invitation.js';

export const toOrganizationDto = (o: Organization): OrganizationDto => ({
  id: o.id,
  name: o.name,
  slug: o.slug,
  createdAt: o.createdAt.toISOString(),
  updatedAt: o.updatedAt.toISOString()
});

export const toMembershipDto = (m: Membership): MembershipDto => ({
  id: m.id,
  organizationId: m.organizationId,
  userId: m.userId,
  role: m.role,
  createdAt: m.createdAt.toISOString()
});

/** Never includes tokenHash. */
export const toInvitationDto = (i: Invitation) => ({
  id: i.id,
  organizationId: i.organizationId,
  email: i.email,
  role: i.role,
  status: i.status,
  expiresAt: i.expiresAt.toISOString()
});
