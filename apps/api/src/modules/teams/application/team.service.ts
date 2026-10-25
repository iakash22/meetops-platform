import type { DirectoryAccess, DirectoryCaller } from '../../directory/access.js';
import {
  EmployeeNotFoundError,
  repoCall,
  TeamMemberNotFoundError,
  TeamNotFoundError,
} from '../../directory/errors.js';
import type {
  EmployeeRepository,
  Page,
  PageRequest,
  TeamCreate,
  TeamMemberRecord,
  TeamMemberRepository,
  TeamMemberRole,
  TeamPatch,
  TeamRecord,
  TeamRepository,
} from '../../directory/ports.js';

export interface TeamServiceRepos {
  teams: TeamRepository;
  teamMembers: TeamMemberRepository;
  employees: EmployeeRepository;
}

/**
 * Teams and team-membership use cases. Membership changes are `update` on the Team subject (owner/admin).
 * Every method runs the CASL check before touching a repository.
 */
export class TeamService {
  constructor(
    private readonly r: TeamServiceRepos,
    private readonly access: DirectoryAccess,
  ) {}

  async list(
    c: DirectoryCaller,
    q: PageRequest & { q?: string | undefined },
  ): Promise<Page<TeamRecord>> {
    this.access.authorize(c, 'read', 'Team');
    return repoCall(this.r.teams.list(c.ctx.organizationId, q));
  }

  async get(c: DirectoryCaller, id: string): Promise<TeamRecord> {
    this.access.authorize(c, 'read', 'Team');
    return this.requireTeam(c, id);
  }

  async create(c: DirectoryCaller, input: TeamCreate): Promise<TeamRecord> {
    this.access.authorize(c, 'create', 'Team');
    const t = await repoCall(this.r.teams.create(c.ctx.organizationId, input));
    await this.access.record(c, { action: 'team.create', targetType: 'team', targetId: t.id });
    return t;
  }

  async update(c: DirectoryCaller, id: string, patch: TeamPatch): Promise<TeamRecord> {
    this.access.authorize(c, 'update', 'Team');
    const t = await repoCall(this.r.teams.update(c.ctx.organizationId, id, patch));
    if (!t) throw new TeamNotFoundError();
    await this.access.record(c, {
      action: 'team.update',
      targetType: 'team',
      targetId: t.id,
      metadata: { fields: Object.keys(patch).sort().join(',') },
    });
    return t;
  }

  async remove(c: DirectoryCaller, id: string): Promise<void> {
    this.access.authorize(c, 'delete', 'Team');
    if (!(await this.r.teams.softDelete(c.ctx.organizationId, id))) throw new TeamNotFoundError();
    await this.access.record(c, { action: 'team.delete', targetType: 'team', targetId: id });
  }

  async listMembers(
    c: DirectoryCaller,
    teamId: string,
    q: PageRequest & { role?: TeamMemberRole | undefined },
  ): Promise<Page<TeamMemberRecord>> {
    this.access.authorize(c, 'read', 'Team');
    await this.requireTeam(c, teamId);
    return repoCall(this.r.teamMembers.list(c.ctx.organizationId, teamId, q));
  }

  async addMember(
    c: DirectoryCaller,
    teamId: string,
    employeeId: string,
    role: TeamMemberRole,
  ): Promise<TeamMemberRecord> {
    this.access.authorize(c, 'update', 'Team');
    await this.requireTeam(c, teamId);
    if (!(await this.r.employees.findById(c.ctx.organizationId, employeeId)))
      throw new EmployeeNotFoundError();
    const m = await repoCall(
      this.r.teamMembers.add(c.ctx.organizationId, teamId, employeeId, role),
    );
    await this.access.record(c, {
      action: 'team_member.add',
      targetType: 'team_member',
      targetId: employeeId,
      metadata: { teamId, role },
    });
    return m;
  }

  async updateMember(
    c: DirectoryCaller,
    teamId: string,
    employeeId: string,
    role: TeamMemberRole,
  ): Promise<TeamMemberRecord> {
    this.access.authorize(c, 'update', 'Team');
    await this.requireTeam(c, teamId);
    const m = await repoCall(
      this.r.teamMembers.updateRole(c.ctx.organizationId, teamId, employeeId, role),
    );
    if (!m) throw new TeamMemberNotFoundError();
    await this.access.record(c, {
      action: 'team_member.update',
      targetType: 'team_member',
      targetId: employeeId,
      metadata: { teamId, role },
    });
    return m;
  }

  async removeMember(c: DirectoryCaller, teamId: string, employeeId: string): Promise<void> {
    this.access.authorize(c, 'update', 'Team');
    await this.requireTeam(c, teamId);
    if (!(await this.r.teamMembers.remove(c.ctx.organizationId, teamId, employeeId)))
      throw new TeamMemberNotFoundError();
    await this.access.record(c, {
      action: 'team_member.remove',
      targetType: 'team_member',
      targetId: employeeId,
      metadata: { teamId },
    });
  }

  private async requireTeam(c: DirectoryCaller, id: string): Promise<TeamRecord> {
    const t = await this.r.teams.findById(c.ctx.organizationId, id);
    if (!t) throw new TeamNotFoundError();
    return t;
  }
}
