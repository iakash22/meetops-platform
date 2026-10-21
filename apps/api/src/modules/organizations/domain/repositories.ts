import type { Organization } from './organization.js';
import type { Membership, Role } from './membership.js';
import type { Invitation } from './invitation.js';

/**
 * Tenant-scoped repositories take organizationId explicitly on every call (from TenantContext,
 * never from request bodies). Prisma implementations use getPrismaClient(), filter
 * { organizationId, deletedAt: null } and run inside withOrgContext(organizationId, fn) (RLS).
 */

/** organizations is a global table (the tenant itself). */
export interface OrganizationRepository {
  create(org: Organization): Promise<Organization>;
  findById(organizationId: string): Promise<Organization | null>;
  findManyByIds(organizationIds: string[]): Promise<Organization[]>;
  slugExists(slug: string): Promise<boolean>;
}

export type MemberMutationResult = 'ok' | 'not_found' | 'last_owner';

export interface MembershipRepository {
  /** Creates the membership; for org creation the Prisma side runs in the same org context. */
  create(organizationId: string, m: Membership): Promise<Membership>;
  find(organizationId: string, userId: string): Promise<Membership | null>;
  listByOrganization(organizationId: string): Promise<Membership[]>;
  /** Cross-tenant by design (user context): only ever called with the authenticated user's own id. */
  listByUser(userId: string): Promise<Membership[]>;
  /** Atomic: refuses (last_owner) if this would leave the org without an owner. */
  setRole(organizationId: string, userId: string, role: Role, at: Date): Promise<MemberMutationResult>;
  /** Atomic soft delete; same last-owner guarantee. */
  remove(organizationId: string, userId: string, at: Date): Promise<MemberMutationResult>;
}

/** Minimal global projection returned by the token-hash lookup (SECURITY DEFINER in Postgres). */
export type InvitationLookup = Pick<Invitation, 'id' | 'organizationId' | 'email' | 'role' | 'status' | 'expiresAt'>;

export interface InvitationRepository {
  create(organizationId: string, inv: Invitation): Promise<Invitation>;
  findById(organizationId: string, id: string): Promise<Invitation | null>;
  findPendingByEmail(organizationId: string, email: string): Promise<Invitation | null>;
  update(organizationId: string, inv: Invitation): Promise<Invitation>;
  /** Worker mints the emailed token: replaces the hash (earlier links stop working). */
  setTokenHash(organizationId: string, id: string, tokenHash: string): Promise<void>;
  /** Pre-tenant lookup by token hash (no organizationId in the token). */
  lookupByTokenHash(tokenHash: string): Promise<InvitationLookup | null>;
  /**
   * Atomic single use: pending + unexpired + email matches → membership created (or restored),
   * invitation marked accepted. Null on any failure. Postgres: accept_invitation(hash, user).
   */
  accept(tokenHash: string, by: { userId: string; email: string }, now: Date): Promise<{ membership: Membership } | null>;
}
