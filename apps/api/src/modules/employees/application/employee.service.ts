import type { DirectoryAccess, DirectoryCaller } from '../../directory/access.js';
import {
  EmployeeNotFoundError,
  repoCall,
  UserNotInOrganizationError,
} from '../../directory/errors.js';
import type {
  EmployeeCreate,
  EmployeePatch,
  EmployeeRecord,
  EmployeeRepository,
  Page,
  PageRequest,
} from '../../directory/ports.js';

/** Employees use cases. Every method runs the CASL check before touching the repository. */
export class EmployeeService {
  constructor(
    private readonly repo: EmployeeRepository,
    private readonly access: DirectoryAccess,
  ) {}

  async list(
    c: DirectoryCaller,
    q: PageRequest & { q?: string | undefined },
  ): Promise<Page<EmployeeRecord>> {
    this.access.authorize(c, 'read', 'Employee');
    return repoCall(this.repo.list(c.ctx.organizationId, q));
  }

  async get(c: DirectoryCaller, id: string): Promise<EmployeeRecord> {
    this.access.authorize(c, 'read', 'Employee');
    const e = await this.repo.findById(c.ctx.organizationId, id);
    if (!e) throw new EmployeeNotFoundError();
    return e;
  }

  async create(c: DirectoryCaller, input: EmployeeCreate): Promise<EmployeeRecord> {
    this.access.authorize(c, 'create', 'Employee');
    await this.assertLinkableUser(c, input.userId);
    const e = await repoCall(this.repo.create(c.ctx.organizationId, input));
    await this.access.record(c, {
      action: 'employee.create',
      targetType: 'employee',
      targetId: e.id,
    });
    return e;
  }

  async update(c: DirectoryCaller, id: string, patch: EmployeePatch): Promise<EmployeeRecord> {
    this.access.authorize(c, 'update', 'Employee');
    await this.assertLinkableUser(c, patch.userId);
    const e = await repoCall(this.repo.update(c.ctx.organizationId, id, patch));
    if (!e) throw new EmployeeNotFoundError();
    await this.access.record(c, {
      action: 'employee.update',
      targetType: 'employee',
      targetId: e.id,
      // Field names only: values (e.g. email) are personal data and stay out of the audit log.
      metadata: { fields: Object.keys(patch).sort().join(',') },
    });
    return e;
  }

  async remove(c: DirectoryCaller, id: string): Promise<void> {
    this.access.authorize(c, 'delete', 'Employee');
    if (!(await this.repo.softDelete(c.ctx.organizationId, id))) throw new EmployeeNotFoundError();
    await this.access.record(c, {
      action: 'employee.delete',
      targetType: 'employee',
      targetId: id,
    });
  }

  /** A linked user must be a member of this organization; anything else is NOT_FOUND. */
  private async assertLinkableUser(c: DirectoryCaller, userId: string | null | undefined) {
    if (!userId) return;
    if (!(await this.access.isOrganizationMember(c, userId)))
      throw new UserNotInOrganizationError();
  }
}
