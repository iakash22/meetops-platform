import { randomUUID } from 'node:crypto';
import { keysetPage } from './cursor.js';
import {
  DirectoryConflict,
  type DirectoryRepositories,
  type EmployeeCreate,
  type EmployeePatch,
  type EmployeeRecord,
  type EmployeeRepository,
  type ProjectCreate,
  type ProjectPatch,
  type ProjectRecord,
  type ProjectRepository,
  type TeamCreate,
  type TeamMemberRecord,
  type TeamMemberRepository,
  type TeamMemberRole,
  type TeamPatch,
  type TeamRecord,
  type TeamRepository,
} from './ports.js';

type Stored<T> = T & { deletedAt: Date | null };

const contains = (hay: string | null, needle: string) =>
  hay !== null && hay.toLowerCase().includes(needle.toLowerCase());

/** Copy only the keys present in `patch` (undefined means "leave", null means "clear"). */
function applyPatch<T extends object>(row: T, patch: object): void {
  for (const [k, v] of Object.entries(patch)) {
    if (v !== undefined) (row as Record<string, unknown>)[k] = v;
  }
}

function strip<T extends { deletedAt: Date | null }>(row: T): Omit<T, 'deletedAt'> {
  const copy: Partial<T> = { ...row };
  delete copy.deletedAt;
  return copy as Omit<T, 'deletedAt'>;
}

/**
 * In-memory directory store for development and tests. Mirrors the Postgres constraints the DB-2 repositories rely
 * on: unique (org, email) and (org, userId) on employees, (org, name) on teams, (org, key) on projects (soft-deleted
 * rows still hold their key and name) and (org, team, employee) on members.
 */
export class InMemoryDirectory implements DirectoryRepositories {
  private readonly employeeRows = new Map<string, Stored<EmployeeRecord>>();
  private readonly teamRows = new Map<string, Stored<TeamRecord>>();
  private readonly projectRows = new Map<string, Stored<ProjectRecord>>();
  private memberRows: Omit<TeamMemberRecord, 'employee'>[] = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  private liveEmployee(orgId: string, id: string) {
    const e = this.employeeRows.get(id);
    return e && e.organizationId === orgId && !e.deletedAt ? e : null;
  }
  private liveTeam(orgId: string, id: string) {
    const t = this.teamRows.get(id);
    return t && t.organizationId === orgId && !t.deletedAt ? t : null;
  }
  private liveProject(orgId: string, id: string) {
    const p = this.projectRows.get(id);
    return p && p.organizationId === orgId && !p.deletedAt ? p : null;
  }

  private assertEmployeeUnique(orgId: string, id: string | null, data: EmployeePatch) {
    for (const e of this.employeeRows.values()) {
      if (e.organizationId !== orgId || e.id === id) continue;
      if (data.email && e.email?.toLowerCase() === data.email.toLowerCase())
        throw new DirectoryConflict('employee_email');
      if (data.userId && e.userId === data.userId) throw new DirectoryConflict('employee_user');
    }
  }
  private assertTeamUnique(orgId: string, id: string | null, name: string | undefined) {
    if (name === undefined) return;
    for (const t of this.teamRows.values())
      if (t.organizationId === orgId && t.id !== id && t.name === name)
        throw new DirectoryConflict('team_name');
  }

  private withEmployee(m: Omit<TeamMemberRecord, 'employee'>): TeamMemberRecord {
    const e = this.employeeRows.get(m.employeeId);
    if (!e) throw new Error('team member without employee');
    return { ...m, employee: strip(e) };
  }

  readonly employees: EmployeeRepository = {
    list: async (orgId, q) => {
      const rows = [...this.employeeRows.values()].filter(
        (e) =>
          e.organizationId === orgId &&
          !e.deletedAt &&
          (!q.q || contains(e.fullName, q.q) || contains(e.email, q.q)),
      );
      const page = keysetPage(rows, (e) => e, q);
      return { items: page.items.map(strip), nextCursor: page.nextCursor };
    },
    findById: async (orgId, id) => {
      const e = this.liveEmployee(orgId, id);
      return e ? strip(e) : null;
    },
    create: async (orgId, data: EmployeeCreate) => {
      this.assertEmployeeUnique(orgId, null, data);
      const now = this.now();
      const row: Stored<EmployeeRecord> = {
        id: randomUUID(),
        organizationId: orgId,
        userId: data.userId ?? null,
        fullName: data.fullName,
        email: data.email ?? null,
        title: data.title ?? null,
        department: data.department ?? null,
        externalId: data.externalId ?? null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      this.employeeRows.set(row.id, row);
      return strip(row);
    },
    update: async (orgId, id, patch) => {
      const e = this.liveEmployee(orgId, id);
      if (!e) return null;
      this.assertEmployeeUnique(orgId, id, patch);
      applyPatch(e, patch);
      e.updatedAt = this.now();
      return strip(e);
    },
    softDelete: async (orgId, id) => {
      const e = this.liveEmployee(orgId, id);
      if (!e) return false;
      e.deletedAt = this.now();
      this.memberRows = this.memberRows.filter(
        (m) => !(m.organizationId === orgId && m.employeeId === id),
      );
      return true;
    },
  };

  readonly teams: TeamRepository = {
    list: async (orgId, q) => {
      const rows = [...this.teamRows.values()].filter(
        (t) => t.organizationId === orgId && !t.deletedAt && (!q.q || contains(t.name, q.q)),
      );
      const page = keysetPage(rows, (t) => t, q);
      return { items: page.items.map(strip), nextCursor: page.nextCursor };
    },
    findById: async (orgId, id) => {
      const t = this.liveTeam(orgId, id);
      return t ? strip(t) : null;
    },
    create: async (orgId, data: TeamCreate) => {
      this.assertTeamUnique(orgId, null, data.name);
      const now = this.now();
      const row: Stored<TeamRecord> = {
        id: randomUUID(),
        organizationId: orgId,
        name: data.name,
        key: data.key ?? null,
        description: data.description ?? null,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      this.teamRows.set(row.id, row);
      return strip(row);
    },
    update: async (orgId, id, patch: TeamPatch) => {
      const t = this.liveTeam(orgId, id);
      if (!t) return null;
      this.assertTeamUnique(orgId, id, patch.name);
      applyPatch(t, patch);
      t.updatedAt = this.now();
      return strip(t);
    },
    softDelete: async (orgId, id) => {
      const t = this.liveTeam(orgId, id);
      if (!t) return false;
      t.deletedAt = this.now();
      this.memberRows = this.memberRows.filter(
        (m) => !(m.organizationId === orgId && m.teamId === id),
      );
      for (const p of this.projectRows.values())
        if (p.organizationId === orgId && p.teamId === id) p.teamId = null;
      return true;
    },
  };

  readonly teamMembers: TeamMemberRepository = {
    list: async (orgId, teamId, q) => {
      const rows = this.memberRows.filter(
        (m) =>
          m.organizationId === orgId &&
          m.teamId === teamId &&
          (!q.role || m.role === q.role) &&
          this.liveEmployee(orgId, m.employeeId) !== null,
      );
      const page = keysetPage(rows, (m) => ({ createdAt: m.createdAt, id: m.employeeId }), q);
      return { items: page.items.map((m) => this.withEmployee(m)), nextCursor: page.nextCursor };
    },
    add: async (orgId, teamId, employeeId, role: TeamMemberRole) => {
      if (
        this.memberRows.some(
          (m) => m.organizationId === orgId && m.teamId === teamId && m.employeeId === employeeId,
        )
      )
        throw new DirectoryConflict('team_member');
      const row = { organizationId: orgId, teamId, employeeId, role, createdAt: this.now() };
      this.memberRows.push(row);
      return this.withEmployee(row);
    },
    updateRole: async (orgId, teamId, employeeId, role) => {
      const m = this.memberRows.find(
        (r) => r.organizationId === orgId && r.teamId === teamId && r.employeeId === employeeId,
      );
      if (!m) return null;
      m.role = role;
      return this.withEmployee(m);
    },
    remove: async (orgId, teamId, employeeId) => {
      const before = this.memberRows.length;
      this.memberRows = this.memberRows.filter(
        (r) => !(r.organizationId === orgId && r.teamId === teamId && r.employeeId === employeeId),
      );
      return this.memberRows.length < before;
    },
  };

  readonly projects: ProjectRepository = {
    list: async (orgId, q) => {
      const rows = [...this.projectRows.values()].filter(
        (p) =>
          p.organizationId === orgId &&
          !p.deletedAt &&
          (!q.status || p.status === q.status) &&
          (!q.teamId || p.teamId === q.teamId) &&
          (!q.q || contains(p.name, q.q) || contains(p.key, q.q)),
      );
      const page = keysetPage(rows, (p) => p, q);
      return { items: page.items.map(strip), nextCursor: page.nextCursor };
    },
    findById: async (orgId, id) => {
      const p = this.liveProject(orgId, id);
      return p ? strip(p) : null;
    },
    create: async (orgId, data: ProjectCreate) => {
      for (const p of this.projectRows.values())
        if (p.organizationId === orgId && p.key === data.key)
          throw new DirectoryConflict('project_key');
      const now = this.now();
      const row: Stored<ProjectRecord> = {
        id: randomUUID(),
        organizationId: orgId,
        teamId: data.teamId ?? null,
        name: data.name,
        key: data.key,
        description: data.description ?? null,
        status: 'active',
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      this.projectRows.set(row.id, row);
      return strip(row);
    },
    update: async (orgId, id, patch: ProjectPatch) => {
      const p = this.liveProject(orgId, id);
      if (!p) return null;
      applyPatch(p, patch);
      p.updatedAt = this.now();
      return strip(p);
    },
    softDelete: async (orgId, id) => {
      const p = this.liveProject(orgId, id);
      if (!p) return false;
      p.deletedAt = this.now();
      return true;
    },
  };
}
