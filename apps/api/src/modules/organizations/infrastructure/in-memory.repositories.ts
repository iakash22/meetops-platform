import { AlreadyMemberError } from '../domain/errors.js';
import type { Organization } from '../domain/organization.js';
import type { Membership, Role } from '../domain/membership.js';
import type { Invitation } from '../domain/invitation.js';
import type {
  InvitationRepository,
  MemberMutationResult,
  MembershipRepository,
  OrganizationRepository
} from '../domain/repositories.js';

const live = <T extends { deletedAt: Date | null }>(x: T | undefined | null) => (x && !x.deletedAt ? x : null);

/** Test/dev only. */
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

/** Test/dev only. Mutations are synchronous, so the last-owner check is atomic in-process. */
export class InMemoryMembershipRepository implements MembershipRepository {
  readonly items: Membership[] = [];
  private live(organizationId: string) {
    return this.items.filter((m) => m.organizationId === organizationId && !m.deletedAt);
  }
  async create(organizationId: string, m: Membership) {
    if (m.organizationId !== organizationId) throw new Error('tenant mismatch');
    const old = this.items.find((x) => x.organizationId === organizationId && x.userId === m.userId);
    if (old) Object.assign(old, { ...m, id: old.id, deletedAt: null });
    else this.items.push({ ...m });
    return old ? { ...old } : m;
  }
  async find(organizationId: string, userId: string) {
    const m = this.live(organizationId).find((x) => x.userId === userId);
    return m ? { ...m } : null;
  }
  async listByOrganization(organizationId: string) {
    return this.live(organizationId).map((m) => ({ ...m }));
  }
  async listByUser(userId: string) {
    return this.items.filter((m) => m.userId === userId && !m.deletedAt).map((m) => ({ ...m }));
  }
  private wouldOrphan(organizationId: string, target: Membership, newRole: Role | null) {
    if (target.role !== 'owner' || newRole === 'owner') return false;
    return this.live(organizationId).filter((m) => m.role === 'owner').length <= 1;
  }
  async setRole(organizationId: string, userId: string, role: Role, at: Date): Promise<MemberMutationResult> {
    const m = this.live(organizationId).find((x) => x.userId === userId);
    if (!m) return 'not_found';
    if (this.wouldOrphan(organizationId, m, role)) return 'last_owner';
    m.role = role;
    m.updatedAt = at;
    return 'ok';
  }
  async remove(organizationId: string, userId: string, at: Date): Promise<MemberMutationResult> {
    const m = this.live(organizationId).find((x) => x.userId === userId);
    if (!m) return 'not_found';
    if (this.wouldOrphan(organizationId, m, null)) return 'last_owner';
    m.deletedAt = at;
    return 'ok';
  }
}

export class InMemoryInvitationRepository implements InvitationRepository {
  readonly items = new Map<string, Invitation>();
  constructor(private readonly memberships?: InMemoryMembershipRepository) {}
  async create(organizationId: string, inv: Invitation) {
    if (inv.organizationId !== organizationId) throw new Error('tenant mismatch');
    this.items.set(inv.id, { ...inv });
    return inv;
  }
  async findById(organizationId: string, id: string) {
    const i = live(this.items.get(id));
    return i && i.organizationId === organizationId ? { ...i } : null;
  }
  async findPendingByEmail(organizationId: string, email: string) {
    const i = live(
      [...this.items.values()].find((x) => x.organizationId === organizationId && x.email === email && x.status === 'pending')
    );
    return i ? { ...i } : null;
  }
  async update(organizationId: string, inv: Invitation) {
    if (inv.organizationId !== organizationId || !this.items.has(inv.id)) throw new Error('tenant mismatch');
    this.items.set(inv.id, { ...inv });
    return inv;
  }
  async setTokenHash(organizationId: string, id: string, tokenHash: string) {
    const i = this.items.get(id);
    if (i && i.organizationId === organizationId) i.tokenHash = tokenHash;
  }
  async lookupByTokenHash(tokenHash: string) {
    const i = live([...this.items.values()].find((x) => x.tokenHash === tokenHash));
    return i ? { id: i.id, organizationId: i.organizationId, email: i.email, role: i.role, status: i.status, expiresAt: i.expiresAt } : null;
  }
  async accept(tokenHash: string, by: { userId: string; email: string }, now: Date) {
    const i = live([...this.items.values()].find((x) => x.tokenHash === tokenHash));
    if (!i || i.status !== 'pending' || i.expiresAt <= now || i.email !== by.email) return null;
    if (!this.memberships) throw new Error('InMemoryInvitationRepository needs the membership repository to accept');
    // Claim synchronously (single use under concurrency), then mirror Postgres accept_invitation():
    // an active membership is never changed and the invitation goes back to pending.
    i.status = 'accepted';
    i.acceptedAt = now;
    i.acceptedById = by.userId;
    if (await this.memberships.find(i.organizationId, by.userId)) {
      Object.assign(i, { status: 'pending', acceptedAt: null, acceptedById: null });
      throw new AlreadyMemberError();
    }
    const membership = await this.memberships.create(i.organizationId, {
      id: globalThis.crypto.randomUUID(),
      organizationId: i.organizationId,
      userId: by.userId,
      role: i.role,
      createdAt: now,
      deletedAt: null
    });
    return { membership };
  }
}
