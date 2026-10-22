import type { Organization } from './organization.js';
import type { Membership } from './membership.js';
import type { Invitation } from './invitation.js';

/**
 * Tenant-scoped repositories take organizationId explicitly on every call (from TenantContext,
 * never from request bodies). Prisma implementations must filter { organizationId, deletedAt: null }
 * and use getPrismaClient(); withOrgContext(organizationId, fn) RLS wrapping is a follow-up.
 */

/** organizations is a global table (the tenant itself). */
export interface OrganizationRepository {
  create(org: Organization): Promise<Organization>;
  findById(organizationId: string): Promise<Organization | null>;
  findManyByIds(organizationIds: string[]): Promise<Organization[]>;
  slugExists(slug: string): Promise<boolean>;
}

export interface MembershipRepository {
  create(organizationId: string, m: Membership): Promise<Membership>;
  find(organizationId: string, userId: string): Promise<Membership | null>;
  /** Cross-tenant by design: only ever called with the authenticated user's own id. */
  listByUser(userId: string): Promise<Membership[]>;
}

export interface InvitationRepository {
  create(organizationId: string, inv: Invitation): Promise<Invitation>;
  findById(organizationId: string, id: string): Promise<Invitation | null>;
  /** Token lookup is necessarily pre-tenant; callers must verify the result's organizationId/email. */
  findByTokenHash(tokenHash: string): Promise<Invitation | null>;
  findPendingByEmail(organizationId: string, email: string): Promise<Invitation | null>;
  update(organizationId: string, inv: Invitation): Promise<Invitation>;
}
