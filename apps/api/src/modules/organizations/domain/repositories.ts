import type { Organization } from './organization.js';
import type { Membership } from './membership.js';
import type { Invitation } from './invitation.js';

export interface OrganizationRepository {
  create(org: Organization): Promise<Organization>;
  findById(id: string): Promise<Organization | null>;
  slugExists(slug: string): Promise<boolean>;
}

export interface MembershipRepository {
  create(m: Membership): Promise<Membership>;
  find(organizationId: string, userId: string): Promise<Membership | null>;
  listByUser(userId: string): Promise<Membership[]>;
}

export interface InvitationRepository {
  create(inv: Invitation): Promise<Invitation>;
  findById(id: string): Promise<Invitation | null>;
  findByTokenHash(tokenHash: string): Promise<Invitation | null>;
  update(inv: Invitation): Promise<Invitation>;
}
