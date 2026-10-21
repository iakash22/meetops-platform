import type { Organization } from '../domain/organization.js';
import type { Membership } from '../domain/membership.js';
import type { Invitation } from '../domain/invitation.js';
import type { InvitationRepository, MembershipRepository, OrganizationRepository } from '../domain/repositories.js';

/** Test/dev only. Prisma implementations come later. */
export class InMemoryOrganizationRepository implements OrganizationRepository {
  private readonly items = new Map<string, Organization>();
  async create(org: Organization) {
    this.items.set(org.id, { ...org });
    return org;
  }
  async findById(id: string) {
    return this.items.get(id) ?? null;
  }
  async slugExists(slug: string) {
    return [...this.items.values()].some((o) => o.slug === slug);
  }
}

export class InMemoryMembershipRepository implements MembershipRepository {
  private readonly items: Membership[] = [];
  async create(m: Membership) {
    this.items.push({ ...m });
    return m;
  }
  async find(organizationId: string, userId: string) {
    return this.items.find((m) => m.organizationId === organizationId && m.userId === userId) ?? null;
  }
  async listByUser(userId: string) {
    return this.items.filter((m) => m.userId === userId);
  }
}

export class InMemoryInvitationRepository implements InvitationRepository {
  private readonly items = new Map<string, Invitation>();
  async create(inv: Invitation) {
    this.items.set(inv.id, { ...inv });
    return inv;
  }
  async findById(id: string) {
    return this.items.get(id) ?? null;
  }
  async findByTokenHash(tokenHash: string) {
    return [...this.items.values()].find((i) => i.tokenHash === tokenHash) ?? null;
  }
  async update(inv: Invitation) {
    this.items.set(inv.id, { ...inv });
    return inv;
  }
}
