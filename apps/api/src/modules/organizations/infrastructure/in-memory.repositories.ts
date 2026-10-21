import type { Organization } from '../domain/organization.js';
import type { Membership } from '../domain/membership.js';
import type { Invitation } from '../domain/invitation.js';
import type { InvitationRepository, MembershipRepository, OrganizationRepository } from '../domain/repositories.js';

const live = <T extends { deletedAt: Date | null }>(x: T | undefined | null) => (x && !x.deletedAt ? x : null);

/** Test/dev only. Prisma implementations come later. */
export class InMemoryOrganizationRepository implements OrganizationRepository {
  private readonly items = new Map<string, Organization>();
  async create(org: Organization) {
    this.items.set(org.id, { ...org });
    return org;
  }
  async findById(organizationId: string) {
    return live(this.items.get(organizationId));
  }
  async findManyByIds(organizationIds: string[]) {
    return organizationIds.map((id) => live(this.items.get(id))).filter((o): o is Organization => o !== null);
  }
  async slugExists(slug: string) {
    return [...this.items.values()].some((o) => o.slug === slug);
  }
}

export class InMemoryMembershipRepository implements MembershipRepository {
  private readonly items: Membership[] = [];
  async create(organizationId: string, m: Membership) {
    if (m.organizationId !== organizationId) throw new Error('tenant mismatch');
    this.items.push({ ...m });
    return m;
  }
  async find(organizationId: string, userId: string) {
    return live(this.items.find((m) => m.organizationId === organizationId && m.userId === userId && !m.deletedAt));
  }
  async listByUser(userId: string) {
    return this.items.filter((m) => m.userId === userId && !m.deletedAt);
  }
}

export class InMemoryInvitationRepository implements InvitationRepository {
  private readonly items = new Map<string, Invitation>();
  async create(organizationId: string, inv: Invitation) {
    if (inv.organizationId !== organizationId) throw new Error('tenant mismatch');
    this.items.set(inv.id, { ...inv });
    return inv;
  }
  async findById(organizationId: string, id: string) {
    const i = live(this.items.get(id));
    return i && i.organizationId === organizationId ? i : null;
  }
  async findByTokenHash(tokenHash: string) {
    return live([...this.items.values()].find((i) => i.tokenHash === tokenHash));
  }
  async findPendingByEmail(organizationId: string, email: string) {
    return live(
      [...this.items.values()].find((i) => i.organizationId === organizationId && i.email === email && i.status === 'pending')
    );
  }
  async update(organizationId: string, inv: Invitation) {
    if (inv.organizationId !== organizationId || !this.items.has(inv.id)) throw new Error('tenant mismatch');
    this.items.set(inv.id, { ...inv });
    return inv;
  }
}
