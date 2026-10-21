import {
  getPrismaClient,
  withOrgContext,
  withUserContextFallback,
  type DatabaseClient,
  type DatabaseTransaction
} from '../../../../shared/prisma/context.js';
import type { Organization } from '../../domain/organization.js';
import type { Membership, Role } from '../../domain/membership.js';
import type { Invitation, InvitationStatus } from '../../domain/invitation.js';
import type {
  InvitationLookup,
  InvitationRepository,
  MemberMutationResult,
  MembershipRepository,
  OrganizationRepository
} from '../../domain/repositories.js';

/**
 * Prisma adapters. Tenant tables (memberships, invitations) always run inside
 * withOrgContext(organizationId, fn) and filter { orgId, deletedAt: null } as well (defence in depth).
 * Column mapping: domain organizationId ↔ org_id.
 */

type OrgRow = { id: string; name: string; slug: string; createdAt: Date; updatedAt: Date; deletedAt: Date | null };
const toOrg = (r: OrgRow): Organization => ({ ...r, createdById: null });

export class PrismaOrganizationRepository implements OrganizationRepository {
  constructor(private readonly db: DatabaseClient = getPrismaClient()) {}
  async create(o: Organization) {
    const r = await this.db.organization.create({
      data: { id: o.id, name: o.name, slug: o.slug, createdAt: o.createdAt }
    });
    return { ...toOrg(r), createdById: o.createdById };
  }
  async findById(organizationId: string) {
    const r = await this.db.organization.findFirst({ where: { id: organizationId, deletedAt: null } });
    return r ? toOrg(r) : null;
  }
  async findManyByIds(organizationIds: string[]) {
    if (!organizationIds.length) return [];
    const rows = await this.db.organization.findMany({ where: { id: { in: organizationIds }, deletedAt: null } });
    return rows.map(toOrg);
  }
  async slugExists(slug: string) {
    return (await this.db.organization.count({ where: { slug } })) > 0;
  }
}

type MemRow = { id: string; orgId: string; userId: string; role: Role; createdAt: Date; updatedAt: Date; deletedAt: Date | null };
const toMembership = (r: MemRow): Membership => ({
  id: r.id,
  organizationId: r.orgId,
  userId: r.userId,
  role: r.role,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  deletedAt: r.deletedAt
});

export class PrismaMembershipRepository implements MembershipRepository {
  constructor(private readonly db: DatabaseClient = getPrismaClient()) {}
  private tx<T>(organizationId: string, fn: (tx: DatabaseTransaction) => Promise<T>) {
    return withOrgContext(organizationId, fn, { client: this.db });
  }
  async create(organizationId: string, m: Membership) {
    if (m.organizationId !== organizationId) throw new Error('tenant mismatch');
    return this.tx(organizationId, async (tx) =>
      toMembership(
        await tx.membership.upsert({
          where: { orgId_userId: { orgId: organizationId, userId: m.userId } },
          create: { id: m.id, orgId: organizationId, userId: m.userId, role: m.role, createdAt: m.createdAt },
          update: { role: m.role, deletedAt: null }
        })
      )
    );
  }
  async find(organizationId: string, userId: string) {
    return this.tx(organizationId, async (tx) => {
      const r = await tx.membership.findFirst({ where: { orgId: organizationId, userId, deletedAt: null } });
      return r ? toMembership(r) : null;
    });
  }
  async listByOrganization(organizationId: string) {
    return this.tx(organizationId, async (tx) =>
      (await tx.membership.findMany({ where: { orgId: organizationId, deletedAt: null }, orderBy: { createdAt: 'asc' } })).map(
        toMembership
      )
    );
  }
  /** User context (membership_self_read policy); TODO(database): withUserContext. */
  async listByUser(userId: string) {
    return withUserContextFallback(
      userId,
      async (tx) => (await tx.membership.findMany({ where: { userId, deletedAt: null } })).map(toMembership),
      this.db
    );
  }

  /** Locks the org's owner rows so two concurrent demotions cannot both pass the check. */
  private async mutate(
    organizationId: string,
    userId: string,
    newRole: Role | null,
    apply: (tx: DatabaseTransaction) => Promise<unknown>
  ): Promise<MemberMutationResult> {
    return this.tx(organizationId, async (tx) => {
      const owners = await tx.$queryRaw<{ user_id: string }[]>`
        SELECT user_id FROM memberships
        WHERE org_id = ${organizationId}::uuid AND role = 'owner' AND deleted_at IS NULL
        FOR UPDATE`;
      const target = await tx.membership.findFirst({ where: { orgId: organizationId, userId, deletedAt: null } });
      if (!target) return 'not_found';
      if (target.role === 'owner' && newRole !== 'owner' && owners.length <= 1) return 'last_owner';
      await apply(tx);
      return 'ok';
    });
  }
  setRole(organizationId: string, userId: string, role: Role, at: Date) {
    return this.mutate(organizationId, userId, role, (tx) =>
      tx.membership.updateMany({ where: { orgId: organizationId, userId, deletedAt: null }, data: { role, updatedAt: at } })
    );
  }
  remove(organizationId: string, userId: string, at: Date) {
    return this.mutate(organizationId, userId, null, (tx) =>
      tx.membership.updateMany({ where: { orgId: organizationId, userId, deletedAt: null }, data: { deletedAt: at } })
    );
  }
}

type DbInvStatus = 'pending' | 'accepted' | 'revoked' | 'expired';
type InvRow = {
  id: string;
  orgId: string;
  email: string;
  role: Role;
  tokenHash: string;
  status: DbInvStatus;
  invitedById: string | null;
  expiresAt: Date;
  acceptedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};
const toStatus = (s: DbInvStatus): InvitationStatus => (s === 'expired' ? 'revoked' : s);
const toInvitation = (r: InvRow): Invitation => ({
  id: r.id,
  organizationId: r.orgId,
  email: r.email,
  role: r.role as Invitation['role'],
  tokenHash: r.tokenHash,
  invitedById: r.invitedById ?? '',
  status: toStatus(r.status),
  expiresAt: r.expiresAt,
  createdAt: r.createdAt,
  acceptedAt: r.acceptedAt,
  // TODO(database): accepted_by_id / revoked_at / deleted_at columns are missing on invitations.
  acceptedById: null,
  revokedAt: r.status === 'revoked' ? r.updatedAt : null,
  deletedAt: null
});

export class PrismaInvitationRepository implements InvitationRepository {
  constructor(private readonly db: DatabaseClient = getPrismaClient()) {}
  private tx<T>(organizationId: string, fn: (tx: DatabaseTransaction) => Promise<T>) {
    return withOrgContext(organizationId, fn, { client: this.db });
  }
  async create(organizationId: string, inv: Invitation) {
    if (inv.organizationId !== organizationId) throw new Error('tenant mismatch');
    return this.tx(organizationId, async (tx) =>
      toInvitation(
        await tx.invitation.create({
          data: {
            id: inv.id,
            orgId: organizationId,
            email: inv.email,
            role: inv.role,
            tokenHash: inv.tokenHash,
            status: inv.status,
            invitedById: inv.invitedById,
            expiresAt: inv.expiresAt,
            createdAt: inv.createdAt
          }
        })
      )
    );
  }
  async findById(organizationId: string, id: string) {
    return this.tx(organizationId, async (tx) => {
      const r = await tx.invitation.findFirst({ where: { orgId: organizationId, id } });
      return r ? toInvitation(r) : null;
    });
  }
  async findPendingByEmail(organizationId: string, email: string) {
    return this.tx(organizationId, async (tx) => {
      const r = await tx.invitation.findFirst({ where: { orgId: organizationId, email, status: 'pending' } });
      return r ? toInvitation(r) : null;
    });
  }
  async update(organizationId: string, inv: Invitation) {
    if (inv.organizationId !== organizationId) throw new Error('tenant mismatch');
    return this.tx(organizationId, async (tx) => {
      const n = await tx.invitation.updateMany({
        where: { orgId: organizationId, id: inv.id },
        data: { status: inv.status, acceptedAt: inv.acceptedAt }
      });
      if (n.count !== 1) throw new Error('tenant mismatch');
      return inv;
    });
  }
  async setTokenHash(organizationId: string, id: string, tokenHash: string) {
    await this.tx(organizationId, (tx) =>
      tx.invitation.updateMany({ where: { orgId: organizationId, id, status: 'pending' }, data: { tokenHash } })
    );
  }
  /** SECURITY DEFINER lookup_invitation_by_token_hash (P1-DB-3): no org context needed. */
  async lookupByTokenHash(tokenHash: string): Promise<InvitationLookup | null> {
    const rows = await this.db.$queryRaw<
      { id: string; org_id: string; email: string; role: Role; status: DbInvStatus; expires_at: Date }[]
    >`SELECT * FROM lookup_invitation_by_token_hash(${tokenHash})`;
    const r = rows[0];
    return r
      ? { id: r.id, organizationId: r.org_id, email: r.email, role: r.role as Invitation['role'], status: toStatus(r.status), expiresAt: r.expires_at }
      : null;
  }
  /**
   * SECURITY DEFINER accept_invitation (P1-DB-3): row-locks the invitation, checks pending/expiry/
   * email, upserts the membership, marks accepted and writes the audit row in one transaction.
   * `now` is the DB clock there.
   */
  async accept(tokenHash: string, by: { userId: string; email: string }) {
    try {
      const rows = await this.db.$queryRaw<{ membership_id: string; org_id: string; role: Role }[]>`
        SELECT * FROM accept_invitation(${tokenHash}, ${by.userId}::uuid)`;
      const r = rows[0];
      if (!r) return null;
      const m = await this.tx(r.org_id, (tx) => tx.membership.findFirst({ where: { orgId: r.org_id, id: r.membership_id } }));
      return m ? { membership: toMembership(m) } : null;
    } catch (e) {
      if (e instanceof Error && e.message.includes('invitation_invalid')) return null;
      throw e;
    }
  }
}
