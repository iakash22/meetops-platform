import type { Clock, IdGenerator } from '../../../shared/ports.js';
import type { SessionRepository } from '../../auth/domain/session.js';
import type { TokenService } from '../../auth/domain/ports.js';
import { normalizeEmail } from '../../users/domain/user.js';
import { slugify, type Organization } from '../domain/organization.js';
import { canGrantRole, type Membership, type Role } from '../domain/membership.js';
import { acceptInvitation, invitationErrors, revokeInvitation, type Invitation } from '../domain/invitation.js';
import { defineAbilityFor } from '../domain/abilities.js';
import { ForbiddenError, NotAMemberError, OrganizationNotFoundError } from '../domain/errors.js';
import type { InvitationRepository, MembershipRepository, OrganizationRepository } from '../domain/repositories.js';

export interface OrganizationServiceDeps {
  organizations: OrganizationRepository;
  memberships: MembershipRepository;
  invitations: InvitationRepository;
  sessions: SessionRepository;
  tokens: TokenService;
  clock: Clock;
  ids: IdGenerator;
  invitationTtlMs: number;
}

export class OrganizationService {
  constructor(private readonly d: OrganizationServiceDeps) {}

  /** Creates an org, makes the creator owner, and activates it on the session. */
  async create(input: { name: string; userId: string; sessionId: string }) {
    const now = this.d.clock.now();
    let slug = slugify(input.name) || 'org';
    if (await this.d.organizations.slugExists(slug)) slug = `${slug}-${this.d.ids.next().slice(0, 8)}`;
    const org: Organization = { id: this.d.ids.next(), name: input.name.trim(), slug, createdById: input.userId, createdAt: now };
    await this.d.organizations.create(org);
    const membership = await this.d.memberships.create({
      id: this.d.ids.next(),
      organizationId: org.id,
      userId: input.userId,
      role: 'owner',
      createdAt: now
    });
    await this.d.sessions.setActiveOrganization(input.sessionId, org.id);
    return { organization: org, membership };
  }

  async listForUser(userId: string) {
    const memberships = await this.d.memberships.listByUser(userId);
    const out: { organization: Organization; role: Role }[] = [];
    for (const m of memberships) {
      const org = await this.d.organizations.findById(m.organizationId);
      if (org) out.push({ organization: org, role: m.role });
    }
    return out;
  }

  /** Switch the active org on the session. Requires membership. */
  async switchActive(input: { organizationId: string; userId: string; sessionId: string }) {
    const org = await this.d.organizations.findById(input.organizationId);
    if (!org) throw new OrganizationNotFoundError();
    const membership = await this.requireMembership(org.id, input.userId);
    await this.d.sessions.setActiveOrganization(input.sessionId, org.id);
    return { organization: org, membership };
  }

  async requireMembership(organizationId: string, userId: string): Promise<Membership> {
    const m = await this.d.memberships.find(organizationId, userId);
    if (!m) throw new NotAMemberError();
    return m;
  }

  /** Returns the invitation and the raw token (to be emailed later; never logged). */
  async invite(input: { organizationId: string; actorUserId: string; email: string; role: Exclude<Role, 'owner'> }) {
    const actor = await this.requireMembership(input.organizationId, input.actorUserId);
    if (defineAbilityFor(actor.role).cannot('invite', 'Invitation') || !canGrantRole(actor.role, input.role)) {
      throw new ForbiddenError();
    }
    const now = this.d.clock.now();
    const token = this.d.tokens.generate();
    const invitation: Invitation = {
      id: this.d.ids.next(),
      organizationId: input.organizationId,
      email: normalizeEmail(input.email),
      role: input.role,
      tokenHash: this.d.tokens.hash(token),
      invitedById: input.actorUserId,
      status: 'pending',
      expiresAt: new Date(now.getTime() + this.d.invitationTtlMs),
      createdAt: now,
      acceptedAt: null,
      acceptedById: null,
      revokedAt: null
    };
    await this.d.invitations.create(invitation);
    return { invitation, token };
  }

  async acceptInvitation(input: { token: string; userId: string; email: string }) {
    const inv = await this.d.invitations.findByTokenHash(this.d.tokens.hash(input.token));
    if (!inv) throw invitationErrors.notFound();
    const now = this.d.clock.now();
    const accepted = acceptInvitation(inv, { userId: input.userId, email: normalizeEmail(input.email) }, now);
    const existing = await this.d.memberships.find(inv.organizationId, input.userId);
    const membership =
      existing ??
      (await this.d.memberships.create({
        id: this.d.ids.next(),
        organizationId: inv.organizationId,
        userId: input.userId,
        role: inv.role,
        createdAt: now
      }));
    await this.d.invitations.update(accepted);
    return { invitation: accepted, membership };
  }

  async revokeInvitation(input: { invitationId: string; actorUserId: string }) {
    const inv = await this.d.invitations.findById(input.invitationId);
    if (!inv) throw invitationErrors.notFound();
    const actor = await this.requireMembership(inv.organizationId, input.actorUserId);
    if (defineAbilityFor(actor.role).cannot('delete', 'Invitation')) throw new ForbiddenError();
    return this.d.invitations.update(revokeInvitation(inv, this.d.clock.now()));
  }
}
