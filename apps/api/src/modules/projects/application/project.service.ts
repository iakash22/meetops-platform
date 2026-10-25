import type { DirectoryAccess, DirectoryCaller } from '../../directory/access.js';
import { ProjectNotFoundError, repoCall, TeamNotFoundError } from '../../directory/errors.js';
import type {
  Page,
  PageRequest,
  ProjectCreate,
  ProjectPatch,
  ProjectRecord,
  ProjectRepository,
  ProjectStatus,
  TeamRepository,
} from '../../directory/ports.js';

export interface ProjectServiceRepos {
  projects: ProjectRepository;
  teams: TeamRepository;
}

export type ProjectListQuery = PageRequest & {
  q?: string | undefined;
  status?: ProjectStatus | undefined;
  teamId?: string | undefined;
};

/** Projects use cases. `key` is immutable after create. CASL check before every repository call. */
export class ProjectService {
  constructor(
    private readonly r: ProjectServiceRepos,
    private readonly access: DirectoryAccess,
  ) {}

  async list(c: DirectoryCaller, q: ProjectListQuery): Promise<Page<ProjectRecord>> {
    this.access.authorize(c, 'read', 'Project');
    return repoCall(this.r.projects.list(c.ctx.organizationId, q));
  }

  async get(c: DirectoryCaller, id: string): Promise<ProjectRecord> {
    this.access.authorize(c, 'read', 'Project');
    const p = await this.r.projects.findById(c.ctx.organizationId, id);
    if (!p) throw new ProjectNotFoundError();
    return p;
  }

  async create(c: DirectoryCaller, input: ProjectCreate): Promise<ProjectRecord> {
    this.access.authorize(c, 'create', 'Project');
    await this.assertTeam(c, input.teamId);
    const p = await repoCall(this.r.projects.create(c.ctx.organizationId, input));
    await this.access.record(c, {
      action: 'project.create',
      targetType: 'project',
      targetId: p.id,
      metadata: { key: p.key },
    });
    return p;
  }

  async update(c: DirectoryCaller, id: string, patch: ProjectPatch): Promise<ProjectRecord> {
    this.access.authorize(c, 'update', 'Project');
    await this.assertTeam(c, patch.teamId);
    const p = await repoCall(this.r.projects.update(c.ctx.organizationId, id, patch));
    if (!p) throw new ProjectNotFoundError();
    await this.access.record(c, {
      action: 'project.update',
      targetType: 'project',
      targetId: p.id,
      metadata: { fields: Object.keys(patch).sort().join(',') },
    });
    return p;
  }

  async remove(c: DirectoryCaller, id: string): Promise<void> {
    this.access.authorize(c, 'delete', 'Project');
    if (!(await this.r.projects.softDelete(c.ctx.organizationId, id)))
      throw new ProjectNotFoundError();
    await this.access.record(c, { action: 'project.delete', targetType: 'project', targetId: id });
  }

  /** An owning team must be a live team of this organization (other-org team ids are TEAM_NOT_FOUND). */
  private async assertTeam(c: DirectoryCaller, teamId: string | null | undefined) {
    if (!teamId) return;
    if (!(await this.r.teams.findById(c.ctx.organizationId, teamId))) throw new TeamNotFoundError();
  }
}
