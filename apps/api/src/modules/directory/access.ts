import type { AuthContext } from '../auth/http/security.js';
import { safeAudit, type AuditEvent, type AuditLog } from '../auth/domain/audit.js';
import type { RequestMeta } from '../auth/application/auth.service.js';
import type { OrganizationService } from '../organizations/application/organization.service.js';
import {
  defineAbilityFor,
  orgSubject,
  type Action,
  type DirectorySubject,
} from '../organizations/domain/abilities.js';
import { OrganizationNotFoundError } from '../organizations/domain/errors.js';
import type { TenantContext } from '../../shared/tenant.js';

/** A resolved directory caller: tenant (from the session, never from input) plus request metadata. */
export interface DirectoryCaller {
  ctx: TenantContext;
  meta: RequestMeta;
}

export type DirectoryAuditInput = Pick<AuditEvent, 'action' | 'targetType' | 'targetId'> & {
  metadata?: AuditEvent['metadata'];
};

/**
 * Tenancy + CASL gate shared by the employees, teams and projects routes.
 *
 * Order on every route: session (401) -> path org must be the session's active org AND the caller a member,
 * otherwise 404 exactly like an unknown org -> CASL check (403) -> repository call.
 */
export class DirectoryAccess {
  constructor(
    private readonly orgs: OrganizationService,
    private readonly audit: AuditLog,
  ) {}

  async caller(
    auth: AuthContext,
    organizationId: string,
    meta: RequestMeta,
  ): Promise<DirectoryCaller> {
    if (auth.session.activeOrganizationId !== organizationId) throw new OrganizationNotFoundError();
    const ctx = await this.orgs.resolveTenant(organizationId, auth.user.id);
    return { ctx, meta };
  }

  /** Throws ForbiddenError (403) unless the role may do `action` on `subject` in this org. */
  authorize(c: DirectoryCaller, action: Action, subject: DirectorySubject): void {
    this.orgs.authorize(c.ctx, action, subject);
  }

  /** Contact details (employee email) are visible to roles that may edit employees: owner and admin. */
  canSeeContactDetails(c: DirectoryCaller): boolean {
    return defineAbilityFor(c.ctx).can(
      'update',
      orgSubject('Employee', { organizationId: c.ctx.organizationId }),
    );
  }

  /** Non-member check for an employee's linked user (contracts: an unknown user is NOT_FOUND). */
  async isOrganizationMember(c: DirectoryCaller, userId: string): Promise<boolean> {
    try {
      await this.orgs.resolveTenant(c.ctx.organizationId, userId);
      return true;
    } catch (e) {
      if (e instanceof OrganizationNotFoundError) return false;
      throw e;
    }
  }

  record(c: DirectoryCaller, e: DirectoryAuditInput): Promise<void> {
    return safeAudit(this.audit, {
      organizationId: c.ctx.organizationId,
      actorId: c.ctx.userId,
      ip: c.meta.ip,
      userAgent: c.meta.userAgent,
      metadata: {},
      ...e,
    });
  }
}
