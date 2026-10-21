import type { Clock, IdGenerator } from '../../../shared/ports.js';
import type { TenantContext } from '../../../shared/tenant.js';
import type { RateLimiter, TokenService } from '../../auth/domain/ports.js';
import type { AuthMailQueue } from '../../auth/domain/mail-jobs.js';
import { safeAudit, type AuditEvent, type AuditLog } from '../../auth/domain/audit.js';
import type { SessionRepository } from '../../auth/domain/session.js';
import type { UserRepository } from '../../users/domain/user.repository.js';
import { RateLimitedError } from '../../auth/domain/errors.js';
import { normalizeEmail } from '../../users/domain/user.js';
import { slugify, type Organization } from '../domain/organization.js';
import { canChangeMemberRole, canGrantRole, canRemoveMember, type Role } from '../domain/membership.js';
import { invitationErrors, InvitationError, revokeInvitation, type Invitation } from '../domain/invitation.js';
import { defineAbilityFor, orgSubject, type Action, type SubjectName } from '../domain/abilities.js';
import {
  EmailNotVerifiedError,
  ForbiddenError,
  LastOwnerError,
  MemberNotFoundError,
  OrganizationNotFoundError
} from '../domain/errors.js';
import type { MemberMutationResult } from '../domain/repositories.js';
import type { InvitationRepository, MembershipRepository, OrganizationRepository } from '../domain/repositories.js';

export interface OrganizationServiceDeps {
  organizations: OrganizationRepository;
  memberships: MembershipRepository;
  invitations: InvitationRepository;
  users: UserRepository;
  sessions: SessionRepository;
  mailQueue: AuthMailQueue;
  audit: AuditLog;
  tokens: TokenService;
  rateLimiter: RateLimiter;
  clock: Clock;
  ids: IdGenerator;
  invitationTtlMs: number;
}

const DAY = 24 * 60 * 60 * 1000;
export const INVITE_LIMITS = {
  sendPerOrg: { limit: 50, windowMs: DAY },
  sendPerAddress: { limit: 5, windowMs: DAY },
  acceptPerIp: { limit: 10, windowMs: 60 * 60 * 1000 }
} as const;

export class OrganizationService {
  constructor(private readonly d: OrganizationServiceDeps) {}

  private async limit(key: string, l: { limit: number; windowMs: number }) {
    const r = await this.d.rateLimiter.consume(key, l.limit, l.windowMs);
    if (!r.allowed) throw new RateLimitedError(r.retryAfterMs);
  }

  private audit(ctx: { organizationId: string; userId: string }, e: Omit<AuditEvent, 'organizationId' | 'actorId' | 'ip' | 'userAgent'>, ip: string | null = null) {
    return safeAudit(this.d.audit, { organizationId: ctx.organizationId, actorId: ctx.userId, ip, userAgent: null, ...e });
  }

  /** D2: unverified accounts cannot create orgs, invite or accept invitations. */
  async requireVerifiedEmail(userId: string) {
    const u = await this.d.users.findById(userId);
    if (!u?.emailVerifiedAt) throw new EmailNotVerifiedError();
    return u;
  }

  /** Build the TenantContext from membership; unknown or non-member orgs → 404. */
  async resolveTenant(organizationId: string, userId: string): Promise<TenantContext> {
    const m = await this.d.memberships.find(organizationId, userId);
    if (!m || !(await this.d.organizations.findById(organizationId))) throw new OrganizationNotFoundError();
    return { organizationId, userId, role: m.role };
  }

  /** CASL gate. Read denial on the org itself is reported as 404 to avoid existence leaks. */
  authorize(ctx: TenantContext, action: Action, type: Exclude<SubjectName, 'all'>) {
    const ability = defineAbilityFor(ctx);
    if (ability.cannot(action, orgSubject(type, { organizationId: ctx.organizationId }))) {
      if (type === 'Organization' && action === 'read') throw new OrganizationNotFoundError();
      throw new ForbiddenError();
    }
  }

  /** Creates an org; the creator becomes owner. Caller rotates the session to activate it. */
  async create(input: { name: string; userId: string }) {
    if (defineAbilityFor({ userId: input.userId, organizationId: null, role: null }).cannot('create', 'Organization')) {
      throw new ForbiddenError();
    }
    await this.requireVerifiedEmail(input.userId);
    const now = this.d.clock.now();
    let slug = slugify(input.name) || 'org';
    if (await this.d.organizations.slugExists(slug)) slug = `${slug}-${this.d.ids.next().slice(0, 8)}`;
    const org: Organization = {
      id: this.d.ids.next(),
      name: input.name.trim(),
      slug,
      createdById: input.userId,
      createdAt: now,
      updatedAt: now,
      deletedAt: null
    };
    await this.d.organizations.create(org);
    const membership = await this.d.memberships.create(org.id, {
      id: this.d.ids.next(),
      organizationId: org.id,
      userId: input.userId,
      role: 'owner',
      createdAt: now,
      deletedAt: null
    });
    await this.audit({ organizationId: org.id, userId: input.userId }, { action: 'org.create', targetType: 'organization', targetId: org.id, metadata: {} });
    return { organization: org, membership };
  }

  /** The caller's own memberships with their orgs (for session responses). */
  async membershipsForUser(userId: string) {
    const memberships = await this.d.memberships.listByUser(userId);
    const orgs = await this.d.organizations.findManyByIds(memberships.map((m) => m.organizationId));
    return orgs.map((organization) => ({
      organization,
      membership: memberships.find((m) => m.organizationId === organization.id)!
    }));
  }

  async listForUser(userId: string) {
    const memberships = await this.d.memberships.listByUser(userId);
    const orgs = await this.d.organizations.findManyByIds(memberships.map((m) => m.organizationId));
    const out: { organization: Organization; role: Role }[] = [];
    for (const org of orgs) {
      const m = memberships.find((x) => x.organizationId === org.id)!;
      this.authorize({ organizationId: org.id, userId, role: m.role }, 'read', 'Organization');
      out.push({ organization: org, role: m.role });
    }
    return out;
  }

  /** Validate a switch target. Caller rotates the session with the new active org. */
  async switchActive(input: { organizationId: string; userId: string }) {
    const ctx = await this.resolveTenant(input.organizationId, input.userId);
    this.authorize(ctx, 'read', 'Organization');
    const organization = (await this.d.organizations.findById(ctx.organizationId))!;
    return { organization, role: ctx.role };
  }

  /**
   * Enumeration-safe: same response whether or not the address has an account or a pending
   * invite (which is replaced). The token is minted by the mail worker; nothing is returned.
   */
  async invite(ctx: TenantContext, input: { email: string; role: Exclude<Role, 'owner'> }) {
    this.authorize(ctx, 'create', 'Invitation');
    if (!canGrantRole(ctx.role, input.role)) throw new ForbiddenError();
    await this.requireVerifiedEmail(ctx.userId);
    const email = normalizeEmail(input.email);
    await this.limit(`invite:org:${ctx.organizationId}`, INVITE_LIMITS.sendPerOrg);
    await this.limit(`invite:addr:${ctx.organizationId}:${email}`, INVITE_LIMITS.sendPerAddress);

    const now = this.d.clock.now();
    const existing = await this.d.invitations.findPendingByEmail(ctx.organizationId, email);
    if (existing) await this.d.invitations.update(ctx.organizationId, revokeInvitation(existing, now));
    const invitation: Invitation = {
      id: this.d.ids.next(),
      organizationId: ctx.organizationId,
      email,
      role: input.role,
      // Unusable placeholder until the worker mints and emails the real token.
      tokenHash: this.d.tokens.hash(this.d.tokens.generate()),
      invitedById: ctx.userId,
      status: 'pending',
      expiresAt: new Date(now.getTime() + this.d.invitationTtlMs),
      createdAt: now,
      acceptedAt: null,
      acceptedById: null,
      revokedAt: null,
      deletedAt: null
    };
    await this.d.invitations.create(ctx.organizationId, invitation);
    await this.d.mailQueue.enqueue({ kind: 'invitation', organizationId: ctx.organizationId, invitationId: invitation.id });
    await this.audit(ctx, { action: 'invitation.create', targetType: 'invitation', targetId: invitation.id, metadata: { role: input.role } });
    return { invitation };
  }

  /**
   * Atomic single use, bound to the invited email; requires a verified email (D2).
   * Every failure is the same InvitationError (404 at HTTP).
   */
  async acceptInvitation(input: { token: string; userId: string; email: string; ip: string | null }) {
    await this.limit(`invite:accept:ip:${input.ip ?? 'unknown'}`, INVITE_LIMITS.acceptPerIp);
    await this.requireVerifiedEmail(input.userId);
    const r = await this.d.invitations.accept(
      this.d.tokens.hash(input.token),
      { userId: input.userId, email: normalizeEmail(input.email) },
      this.d.clock.now()
    );
    if (!r) throw invitationErrors.notFound();
    const organization = await this.d.organizations.findById(r.membership.organizationId);
    if (!organization) throw invitationErrors.notFound();
    // Postgres accept_invitation() writes its own audit row; in-memory/other adapters rely on this one.
    await this.audit(
      { organizationId: organization.id, userId: input.userId },
      { action: 'invitation.accepted', targetType: 'membership', targetId: r.membership.id, metadata: { role: r.membership.role } },
      input.ip
    );
    return { membership: r.membership, organization };
  }

  async revokeInvitation(ctx: TenantContext, invitationId: string) {
    this.authorize(ctx, 'delete', 'Invitation');
    const inv = await this.d.invitations.findById(ctx.organizationId, invitationId);
    if (!inv) throw invitationErrors.notFound();
    const r = await this.d.invitations.update(ctx.organizationId, revokeInvitation(inv, this.d.clock.now()));
    await this.audit(ctx, { action: 'invitation.revoke', targetType: 'invitation', targetId: inv.id, metadata: {} });
    return r;
  }

  async listMembers(ctx: TenantContext) {
    this.authorize(ctx, 'read', 'Membership');
    return this.d.memberships.listByOrganization(ctx.organizationId);
  }

  private check(r: MemberMutationResult) {
    if (r === 'not_found') throw new MemberNotFoundError();
    if (r === 'last_owner') throw new LastOwnerError();
  }

  /**
   * AU-29..31. Target sessions are revoked on any privilege change (the HTTP layer rotates the
   * caller's own session when they change themselves).
   */
  async changeRole(ctx: TenantContext, targetUserId: string, role: Role) {
    this.authorize(ctx, 'update', 'Membership');
    const target = await this.d.memberships.find(ctx.organizationId, targetUserId);
    if (!target) throw new MemberNotFoundError();
    if (!canChangeMemberRole(ctx, target, role)) throw new ForbiddenError();
    if (target.role === role) return { ...target };
    this.check(await this.d.memberships.setRole(ctx.organizationId, targetUserId, role, this.d.clock.now()));
    if (targetUserId !== ctx.userId) await this.d.sessions.revokeAllForUser(targetUserId, this.d.clock.now());
    await this.audit(ctx, { action: 'membership.role_change', targetType: 'membership', targetId: target.id, metadata: { from: target.role, to: role } });
    return { ...target, role };
  }

  async removeMember(ctx: TenantContext, targetUserId: string) {
    const target = await this.d.memberships.find(ctx.organizationId, targetUserId);
    if (!target) throw new MemberNotFoundError();
    if (targetUserId !== ctx.userId) this.authorize(ctx, 'delete', 'Membership');
    if (!canRemoveMember(ctx, target)) throw new ForbiddenError();
    this.check(await this.d.memberships.remove(ctx.organizationId, targetUserId, this.d.clock.now()));
    if (targetUserId !== ctx.userId) await this.d.sessions.revokeAllForUser(targetUserId, this.d.clock.now());
    await this.audit(ctx, { action: 'membership.remove', targetType: 'membership', targetId: target.id, metadata: { role: target.role } });
  }
}

export { InvitationError };
