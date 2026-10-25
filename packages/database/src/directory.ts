import { Prisma } from '@prisma/client';
import { getPrismaClient } from './client.js';
import { runWithOrganizationContext } from './tenant.js';
import type { RepositoryOptions } from './transcript-repository.js';

/**
 * Directory repositories (DB-2): employees, teams, team members and projects.
 *
 * Every call runs in runWithOrganizationContext(organizationId, ...), so forced RLS limits it to that
 * organization. Rows of another organization, soft-deleted rows and ids that are not UUIDs all read
 * as "not found" (null / false), so routes can answer 404 without leaking existence. Uniqueness and
 * missing references raise a typed DirectoryError whose `reason` matches the contracts
 * (`PROJECT_KEY_TAKEN`, `TEAM_MEMBER_EXISTS`, `TEAM_NOT_FOUND`, `EMPLOYEE_NOT_FOUND`, ...).
 *
 * Records carry Date timestamps; the API maps them to the contract DTOs (ISO strings, email
 * visibility). Lists are keyset pages ordered by (createdAt, id) with an opaque `nextCursor` that is
 * null on the last page, matching `CursorPage` in @meetops/contracts.
 */

export const DIRECTORY_DEFAULT_PAGE_LIMIT = 25;
export const DIRECTORY_MAX_PAGE_LIMIT = 100;
/** Same bound as MAX_CURSOR_LENGTH in @meetops/contracts. */
export const DIRECTORY_MAX_CURSOR_LENGTH = 512;

export type DirectoryErrorReason =
  | 'PROJECT_KEY_TAKEN'
  | 'TEAM_NAME_TAKEN'
  | 'TEAM_MEMBER_EXISTS'
  | 'EMPLOYEE_EMAIL_TAKEN'
  | 'EMPLOYEE_USER_TAKEN'
  | 'EMPLOYEE_NOT_FOUND'
  | 'TEAM_NOT_FOUND'
  | 'USER_NOT_MEMBER'
  | 'INVALID_CURSOR';

export type DirectoryErrorKind = 'conflict' | 'not_found' | 'invalid';

const KIND: Record<DirectoryErrorReason, DirectoryErrorKind> = {
  PROJECT_KEY_TAKEN: 'conflict',
  TEAM_NAME_TAKEN: 'conflict',
  TEAM_MEMBER_EXISTS: 'conflict',
  EMPLOYEE_EMAIL_TAKEN: 'conflict',
  EMPLOYEE_USER_TAKEN: 'conflict',
  EMPLOYEE_NOT_FOUND: 'not_found',
  TEAM_NOT_FOUND: 'not_found',
  USER_NOT_MEMBER: 'not_found',
  INVALID_CURSOR: 'invalid',
};

/**
 * Typed directory failure. `kind` maps to the HTTP status (conflict 409, not_found 404,
 * invalid 400); `reason` goes in the contract's `error.reason` where one exists.
 */
export class DirectoryError extends Error {
  readonly kind: DirectoryErrorKind;
  constructor(readonly reason: DirectoryErrorReason) {
    super(`directory: ${reason}`);
    this.name = 'DirectoryError';
    this.kind = KIND[reason];
  }
}

export const isDirectoryError = (e: unknown): e is DirectoryError => e instanceof DirectoryError;

export interface DirectoryPage<T> {
  items: T[];
  nextCursor: string | null;
}
export interface DirectoryPageQuery {
  cursor?: string;
  /** 1..DIRECTORY_MAX_PAGE_LIMIT; defaults to DIRECTORY_DEFAULT_PAGE_LIMIT. */
  limit?: number;
}

export interface EmployeeRecord {
  id: string;
  organizationId: string;
  userId: string | null;
  fullName: string;
  email: string | null;
  title: string | null;
  department: string | null;
  externalId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface CreateEmployeeInput {
  fullName: string;
  email?: string;
  title?: string;
  department?: string;
  externalId?: string;
  /** Must be a member of the organization, else DirectoryError('USER_NOT_MEMBER'). */
  userId?: string;
}
export interface UpdateEmployeeInput {
  fullName?: string;
  email?: string | null;
  title?: string | null;
  department?: string | null;
  externalId?: string | null;
  userId?: string | null;
}
export interface ListEmployeesInput extends DirectoryPageQuery {
  /** Case-insensitive substring of fullName or email. */
  q?: string;
}

export interface TeamRecord {
  id: string;
  organizationId: string;
  name: string;
  key: string | null;
  description: string | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface CreateTeamInput {
  name: string;
  key?: string;
  description?: string;
}
export interface UpdateTeamInput {
  name?: string;
  key?: string | null;
  description?: string | null;
}
export interface ListTeamsInput extends DirectoryPageQuery {
  /** Case-insensitive substring of name. */
  q?: string;
}

export type DirectoryTeamMemberRole = 'lead' | 'member';
export interface TeamMemberRecord {
  organizationId: string;
  teamId: string;
  employeeId: string;
  role: DirectoryTeamMemberRole;
  createdAt: Date;
  employee: EmployeeRecord;
}
export interface ListTeamMembersInput extends DirectoryPageQuery {
  role?: DirectoryTeamMemberRole;
}

export type DirectoryProjectStatus = 'active' | 'archived';
export interface ProjectRecord {
  id: string;
  organizationId: string;
  name: string;
  key: string;
  description: string | null;
  status: DirectoryProjectStatus;
  teamId: string | null;
  createdAt: Date;
  updatedAt: Date;
}
export interface CreateProjectInput {
  name: string;
  /** Unique per organization, including soft-deleted projects; immutable after create. */
  key: string;
  description?: string;
  /** Must be a live team of the organization, else DirectoryError('TEAM_NOT_FOUND'). */
  teamId?: string;
}
export interface UpdateProjectInput {
  name?: string;
  description?: string | null;
  status?: DirectoryProjectStatus;
  teamId?: string | null;
}
export interface ListProjectsInput extends DirectoryPageQuery {
  status?: DirectoryProjectStatus;
  teamId?: string;
  /** Case-insensitive substring of name or key. */
  q?: string;
}

type Tx = Prisma.TransactionClient;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v);

function runner(options: RepositoryOptions) {
  return <T>(organizationId: string, fn: (tx: Tx) => Promise<T>): Promise<T> =>
    runWithOrganizationContext(options.client ?? getPrismaClient(), organizationId, fn, {
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
}

/** Drop undefined keys so Prisma leaves those columns alone (exactOptionalPropertyTypes friendly). */
function defined<T extends object>(input: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}

/**
 * Explicit field picks for writes: only these columns ever reach Prisma, so extra fields in a
 * caller's input (organizationId, id, deletedAt, ...) can never override tenant or system columns.
 */
function employeeCreateFields(input: CreateEmployeeInput) {
  const { fullName, email, title, department, externalId, userId } = input;
  return defined({ fullName, email, title, department, externalId, userId });
}
function employeeUpdateFields(input: UpdateEmployeeInput) {
  const { fullName, email, title, department, externalId, userId } = input;
  return defined({ fullName, email, title, department, externalId, userId });
}
function teamCreateFields(input: CreateTeamInput) {
  const { name, key, description } = input;
  return defined({ name, key, description });
}
function teamUpdateFields(input: UpdateTeamInput) {
  const { name, key, description } = input;
  return defined({ name, key, description });
}
function projectCreateFields(input: CreateProjectInput) {
  const { name, key, description, teamId } = input;
  return defined({ name, key, description, teamId });
}

// ---- cursors ---------------------------------------------------------------------------------

interface Keyset {
  createdAt: Date;
  id: string;
}

/** Opaque cursor: base64url("d1:" + createdAt ISO + "|" + id). */
export function encodeDirectoryCursor(row: Keyset): string {
  return Buffer.from(`d1:${row.createdAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

/** Parse a cursor from encodeDirectoryCursor; anything else is DirectoryError('INVALID_CURSOR'). */
export function decodeDirectoryCursor(cursor: string): Keyset {
  if (
    typeof cursor !== 'string' ||
    cursor.length === 0 ||
    cursor.length > DIRECTORY_MAX_CURSOR_LENGTH
  ) {
    throw new DirectoryError('INVALID_CURSOR');
  }
  const m = /^d1:(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\|([0-9a-f-]{36})$/i.exec(
    Buffer.from(cursor, 'base64url').toString('utf8'),
  );
  const createdAt = m ? new Date(m[1]!) : undefined;
  if (!m || !createdAt || Number.isNaN(createdAt.getTime()) || !isUuid(m[2])) {
    throw new DirectoryError('INVALID_CURSOR');
  }
  return { createdAt, id: m[2] };
}

function pageLimit(limit: number | undefined): number {
  if (limit === undefined) return DIRECTORY_DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > DIRECTORY_MAX_PAGE_LIMIT) {
    throw new RangeError(`limit must be an integer in 1..${DIRECTORY_MAX_PAGE_LIMIT}`);
  }
  return limit;
}

/** Keyset filter strictly after the cursor row, for ORDER BY createdAt ASC, id ASC. */
function after(cursor: string | undefined) {
  if (cursor === undefined) return {};
  const k = decodeDirectoryCursor(cursor);
  return {
    OR: [{ createdAt: { gt: k.createdAt } }, { createdAt: k.createdAt, id: { gt: k.id } }],
  };
}

const KEYSET_ORDER = [{ createdAt: 'asc' as const }, { id: 'asc' as const }];

function toPage<T, R extends Keyset>(rows: R[], limit: number, map: (r: R) => T): DirectoryPage<T> {
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return { items: page.map(map), nextCursor: more && last ? encodeDirectoryCursor(last) : null };
}

// ---- Prisma error mapping --------------------------------------------------------------------

/**
 * Prisma 5 reports `meta.target: null` for these composite constraints, so each write pre-checks its
 * unique keys inside the transaction (exact reason) and a P2002 that still slips through (a
 * concurrent insert) maps to the caller's fallback reason.
 */
function uniqueTarget(e: unknown): string | undefined {
  if (!(e instanceof Prisma.PrismaClientKnownRequestError) || e.code !== 'P2002') return undefined;
  const t = (e.meta as { target?: unknown } | undefined)?.target;
  return Array.isArray(t) ? t.join(',') : typeof t === 'string' ? t : '';
}
const isFkViolation = (e: unknown): boolean =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2003';

async function mapErrors<T>(
  work: Promise<T>,
  unique: (target: string) => DirectoryErrorReason | undefined,
  fallback: DirectoryErrorReason,
  fk?: DirectoryErrorReason,
): Promise<T> {
  try {
    return await work;
  } catch (e) {
    const target = uniqueTarget(e);
    const reason = target !== undefined ? (unique(target) ?? fallback) : undefined;
    if (reason) throw new DirectoryError(reason);
    if (fk && isFkViolation(e)) throw new DirectoryError(fk);
    throw e;
  }
}

const employeeUnique = (t: string): DirectoryErrorReason | undefined =>
  /email/i.test(t) ? 'EMPLOYEE_EMAIL_TAKEN' : /user/i.test(t) ? 'EMPLOYEE_USER_TAKEN' : undefined;
const teamUnique = (t: string): DirectoryErrorReason | undefined =>
  /name/i.test(t) ? 'TEAM_NAME_TAKEN' : undefined;
const projectUnique = (t: string): DirectoryErrorReason | undefined =>
  /key/i.test(t) ? 'PROJECT_KEY_TAKEN' : undefined;
const memberUnique = (t: string): DirectoryErrorReason | undefined =>
  /team/i.test(t) && /employee/i.test(t) ? 'TEAM_MEMBER_EXISTS' : undefined;

// ---- shared lookups --------------------------------------------------------------------------

const EMPLOYEE_SELECT = {
  id: true,
  organizationId: true,
  userId: true,
  fullName: true,
  email: true,
  title: true,
  department: true,
  externalId: true,
  createdAt: true,
  updatedAt: true,
} as const;
const TEAM_SELECT = {
  id: true,
  organizationId: true,
  name: true,
  key: true,
  description: true,
  createdAt: true,
  updatedAt: true,
} as const;
const PROJECT_SELECT = {
  id: true,
  organizationId: true,
  name: true,
  key: true,
  description: true,
  status: true,
  teamId: true,
  createdAt: true,
  updatedAt: true,
} as const;
const MEMBER_SELECT = {
  id: true,
  organizationId: true,
  teamId: true,
  employeeId: true,
  role: true,
  createdAt: true,
  employee: { select: EMPLOYEE_SELECT },
} as const;

type MemberRow = Prisma.TeamMemberGetPayload<{ select: typeof MEMBER_SELECT }>;
const toMember = (row: MemberRow): TeamMemberRecord => {
  const { id, ...member } = row;
  void id; // surrogate key is only used for keyset paging
  return member;
};

async function liveTeamExists(tx: Tx, organizationId: string, teamId: string): Promise<boolean> {
  if (!isUuid(teamId)) return false;
  const n = await tx.team.count({ where: { organizationId, id: teamId, deletedAt: null } });
  return n === 1;
}
async function liveEmployeeExists(tx: Tx, organizationId: string, employeeId: string) {
  if (!isUuid(employeeId)) return false;
  const n = await tx.employee.count({ where: { organizationId, id: employeeId, deletedAt: null } });
  return n === 1;
}
async function assertMember(tx: Tx, organizationId: string, userId: string): Promise<void> {
  const ok =
    isUuid(userId) &&
    (await tx.membership.count({ where: { organizationId, userId, deletedAt: null } })) === 1;
  if (!ok) throw new DirectoryError('USER_NOT_MEMBER');
}

/** Throw `reason` when another row of the org (soft-deleted included) already holds the value. */
async function assertFree(count: Promise<number>, reason: DirectoryErrorReason): Promise<void> {
  if ((await count) > 0) throw new DirectoryError(reason);
}
const notSelf = (id: string | undefined) => (id === undefined ? {} : { NOT: { id } });

async function assertEmployeeFree(
  tx: Tx,
  organizationId: string,
  input: { email?: string | null; userId?: string | null },
  selfId?: string,
): Promise<void> {
  if (typeof input.email === 'string') {
    await assertFree(
      tx.employee.count({ where: { organizationId, email: input.email, ...notSelf(selfId) } }),
      'EMPLOYEE_EMAIL_TAKEN',
    );
  }
  if (typeof input.userId === 'string') {
    await assertMember(tx, organizationId, input.userId);
    await assertFree(
      tx.employee.count({ where: { organizationId, userId: input.userId, ...notSelf(selfId) } }),
      'EMPLOYEE_USER_TAKEN',
    );
  }
}
const employeeFallback = (input: { email?: string | null }): DirectoryErrorReason =>
  typeof input.email === 'string' ? 'EMPLOYEE_EMAIL_TAKEN' : 'EMPLOYEE_USER_TAKEN';

const contains = (q: string) => ({ contains: q, mode: 'insensitive' as const });

// ---- employees -------------------------------------------------------------------------------

/** Employees of one organization. Soft-deleted employees are never returned or updated. */
export function createEmployeeRepository(options: RepositoryOptions = {}) {
  const run = runner(options);
  return {
    get(organizationId: string, employeeId: string): Promise<EmployeeRecord | null> {
      return run(organizationId, (tx) =>
        isUuid(employeeId)
          ? tx.employee.findFirst({
              where: { organizationId, id: employeeId, deletedAt: null },
              select: EMPLOYEE_SELECT,
            })
          : Promise.resolve(null),
      );
    },

    async list(
      organizationId: string,
      input: ListEmployeesInput = {},
    ): Promise<DirectoryPage<EmployeeRecord>> {
      const limit = pageLimit(input.limit);
      const cursor = after(input.cursor);
      return run(organizationId, async (tx) => {
        const rows = await tx.employee.findMany({
          where: {
            organizationId,
            deletedAt: null,
            ...(input.q
              ? {
                  AND: [
                    cursor,
                    { OR: [{ fullName: contains(input.q) }, { email: contains(input.q) }] },
                  ],
                }
              : cursor),
          },
          orderBy: KEYSET_ORDER,
          take: limit + 1,
          select: EMPLOYEE_SELECT,
        });
        return toPage(rows, limit, (r) => r);
      });
    },

    create(organizationId: string, input: CreateEmployeeInput): Promise<EmployeeRecord> {
      return mapErrors(
        run(organizationId, async (tx) => {
          await assertEmployeeFree(tx, organizationId, input);
          return tx.employee.create({
            data: { ...employeeCreateFields(input), organizationId },
            select: EMPLOYEE_SELECT,
          });
        }),
        employeeUnique,
        employeeFallback(input),
      );
    },

    /** Returns null when the employee is missing, soft-deleted or in another organization. */
    update(
      organizationId: string,
      employeeId: string,
      input: UpdateEmployeeInput,
    ): Promise<EmployeeRecord | null> {
      return mapErrors(
        run(organizationId, async (tx) => {
          if (!(await liveEmployeeExists(tx, organizationId, employeeId))) return null;
          await assertEmployeeFree(tx, organizationId, input, employeeId);
          return tx.employee.update({
            where: { organizationId_id: { organizationId, id: employeeId } },
            data: employeeUpdateFields(input),
            select: EMPLOYEE_SELECT,
          });
        }),
        employeeUnique,
        employeeFallback(input),
      );
    },

    /** Soft delete. Returns false when there was no live employee with that id. */
    softDelete(organizationId: string, employeeId: string): Promise<boolean> {
      return run(organizationId, async (tx) => {
        if (!isUuid(employeeId)) return false;
        const r = await tx.employee.updateMany({
          where: { organizationId, id: employeeId, deletedAt: null },
          data: { deletedAt: new Date() },
        });
        return r.count === 1;
      });
    },
  };
}

// ---- teams -----------------------------------------------------------------------------------

/** Teams of one organization. Names are unique per organization, including soft-deleted teams. */
export function createTeamRepository(options: RepositoryOptions = {}) {
  const run = runner(options);
  return {
    get(organizationId: string, teamId: string): Promise<TeamRecord | null> {
      return run(organizationId, (tx) =>
        isUuid(teamId)
          ? tx.team.findFirst({
              where: { organizationId, id: teamId, deletedAt: null },
              select: TEAM_SELECT,
            })
          : Promise.resolve(null),
      );
    },

    async list(
      organizationId: string,
      input: ListTeamsInput = {},
    ): Promise<DirectoryPage<TeamRecord>> {
      const limit = pageLimit(input.limit);
      const cursor = after(input.cursor);
      return run(organizationId, async (tx) => {
        const rows = await tx.team.findMany({
          where: {
            organizationId,
            deletedAt: null,
            ...(input.q ? { AND: [cursor, { name: contains(input.q) }] } : cursor),
          },
          orderBy: KEYSET_ORDER,
          take: limit + 1,
          select: TEAM_SELECT,
        });
        return toPage(rows, limit, (r) => r);
      });
    },

    create(organizationId: string, input: CreateTeamInput): Promise<TeamRecord> {
      return mapErrors(
        run(organizationId, async (tx) => {
          await assertFree(
            tx.team.count({ where: { organizationId, name: input.name } }),
            'TEAM_NAME_TAKEN',
          );
          return tx.team.create({
            data: { ...teamCreateFields(input), organizationId },
            select: TEAM_SELECT,
          });
        }),
        teamUnique,
        'TEAM_NAME_TAKEN',
      );
    },

    update(
      organizationId: string,
      teamId: string,
      input: UpdateTeamInput,
    ): Promise<TeamRecord | null> {
      return mapErrors(
        run(organizationId, async (tx) => {
          if (!(await liveTeamExists(tx, organizationId, teamId))) return null;
          if (input.name !== undefined) {
            await assertFree(
              tx.team.count({ where: { organizationId, name: input.name, NOT: { id: teamId } } }),
              'TEAM_NAME_TAKEN',
            );
          }
          return tx.team.update({
            where: { organizationId_id: { organizationId, id: teamId } },
            data: teamUpdateFields(input),
            select: TEAM_SELECT,
          });
        }),
        teamUnique,
        'TEAM_NAME_TAKEN',
      );
    },

    /**
     * Soft delete, and unlink the team's projects (teamId = null, soft-deleted projects included) in
     * the same transaction: either both happen or neither does. Member rows stay; a soft-deleted
     * team reads as TEAM_NOT_FOUND. Returns false (and touches nothing) when there was no live team.
     */
    softDelete(organizationId: string, teamId: string): Promise<boolean> {
      return run(organizationId, async (tx) => {
        if (!isUuid(teamId)) return false;
        const r = await tx.team.updateMany({
          where: { organizationId, id: teamId, deletedAt: null },
          data: { deletedAt: new Date() },
        });
        if (r.count !== 1) return false;
        await tx.project.updateMany({ where: { organizationId, teamId }, data: { teamId: null } });
        return true;
      });
    },
  };
}

// ---- team members ----------------------------------------------------------------------------

/**
 * Team memberships. Only live teams and live employees count: a soft-deleted team reads as
 * TEAM_NOT_FOUND, and members whose employee is soft-deleted are hidden from lists.
 */
export function createTeamMemberRepository(options: RepositoryOptions = {}) {
  const run = runner(options);
  return {
    /** Returns null when the team is missing, soft-deleted or in another organization. */
    async list(
      organizationId: string,
      teamId: string,
      input: ListTeamMembersInput = {},
    ): Promise<DirectoryPage<TeamMemberRecord> | null> {
      const limit = pageLimit(input.limit);
      const cursor = after(input.cursor);
      return run(organizationId, async (tx) => {
        if (!(await liveTeamExists(tx, organizationId, teamId))) return null;
        const rows = await tx.teamMember.findMany({
          where: {
            organizationId,
            teamId,
            employee: { deletedAt: null },
            ...(input.role ? { role: input.role } : {}),
            ...cursor,
          },
          orderBy: KEYSET_ORDER,
          take: limit + 1,
          select: MEMBER_SELECT,
        });
        return toPage(rows, limit, toMember);
      });
    },

    get(
      organizationId: string,
      teamId: string,
      employeeId: string,
    ): Promise<TeamMemberRecord | null> {
      return run(organizationId, async (tx) => {
        if (!isUuid(employeeId) || !(await liveTeamExists(tx, organizationId, teamId))) return null;
        const row = await tx.teamMember.findFirst({
          where: { organizationId, teamId, employeeId, employee: { deletedAt: null } },
          select: MEMBER_SELECT,
        });
        return row ? toMember(row) : null;
      });
    },

    /** TEAM_NOT_FOUND / EMPLOYEE_NOT_FOUND for unknown ids, TEAM_MEMBER_EXISTS for a repeat add. */
    add(
      organizationId: string,
      teamId: string,
      employeeId: string,
      role: DirectoryTeamMemberRole = 'member',
    ): Promise<TeamMemberRecord> {
      return mapErrors(
        run(organizationId, async (tx) => {
          if (!(await liveTeamExists(tx, organizationId, teamId)))
            throw new DirectoryError('TEAM_NOT_FOUND');
          if (!(await liveEmployeeExists(tx, organizationId, employeeId))) {
            throw new DirectoryError('EMPLOYEE_NOT_FOUND');
          }
          return toMember(
            await tx.teamMember.create({
              data: { organizationId, teamId, employeeId, role },
              select: MEMBER_SELECT,
            }),
          );
        }),
        memberUnique,
        'TEAM_MEMBER_EXISTS',
      );
    },

    /** Returns null when the membership (or its team or employee) is not live in this organization. */
    updateRole(
      organizationId: string,
      teamId: string,
      employeeId: string,
      role: DirectoryTeamMemberRole,
    ): Promise<TeamMemberRecord | null> {
      return run(organizationId, async (tx) => {
        if (!isUuid(employeeId) || !(await liveTeamExists(tx, organizationId, teamId))) return null;
        const r = await tx.teamMember.updateMany({
          where: { organizationId, teamId, employeeId, employee: { deletedAt: null } },
          data: { role },
        });
        if (r.count !== 1) return null;
        const row = await tx.teamMember.findFirst({
          where: { organizationId, teamId, employeeId },
          select: MEMBER_SELECT,
        });
        return row ? toMember(row) : null;
      });
    },

    /** Hard delete of the membership row (team_members has no deleted_at). */
    remove(organizationId: string, teamId: string, employeeId: string): Promise<boolean> {
      return run(organizationId, async (tx) => {
        if (!isUuid(employeeId) || !(await liveTeamExists(tx, organizationId, teamId)))
          return false;
        const r = await tx.teamMember.deleteMany({ where: { organizationId, teamId, employeeId } });
        return r.count === 1;
      });
    },
  };
}

// ---- projects --------------------------------------------------------------------------------

/** Projects of one organization. `key` is unique per organization (soft-deleted included). */
export function createProjectRepository(options: RepositoryOptions = {}) {
  const run = runner(options);
  return {
    get(organizationId: string, projectId: string): Promise<ProjectRecord | null> {
      return run(organizationId, (tx) =>
        isUuid(projectId)
          ? tx.project.findFirst({
              where: { organizationId, id: projectId, deletedAt: null },
              select: PROJECT_SELECT,
            })
          : Promise.resolve(null),
      );
    },

    async list(
      organizationId: string,
      input: ListProjectsInput = {},
    ): Promise<DirectoryPage<ProjectRecord>> {
      const limit = pageLimit(input.limit);
      const cursor = after(input.cursor);
      return run(organizationId, async (tx) => {
        if (input.teamId !== undefined && !isUuid(input.teamId))
          return { items: [], nextCursor: null };
        const rows = await tx.project.findMany({
          where: {
            organizationId,
            deletedAt: null,
            ...(input.status ? { status: input.status } : {}),
            ...(input.teamId ? { teamId: input.teamId } : {}),
            ...(input.q
              ? { AND: [cursor, { OR: [{ name: contains(input.q) }, { key: contains(input.q) }] }] }
              : cursor),
          },
          orderBy: KEYSET_ORDER,
          take: limit + 1,
          select: PROJECT_SELECT,
        });
        return toPage(rows, limit, (r) => r);
      });
    },

    /** PROJECT_KEY_TAKEN for a duplicate key; TEAM_NOT_FOUND for an unknown or other-org team. */
    create(organizationId: string, input: CreateProjectInput): Promise<ProjectRecord> {
      return mapErrors(
        run(organizationId, async (tx) => {
          if (
            input.teamId !== undefined &&
            !(await liveTeamExists(tx, organizationId, input.teamId))
          ) {
            throw new DirectoryError('TEAM_NOT_FOUND');
          }
          await assertFree(
            tx.project.count({ where: { organizationId, key: input.key } }),
            'PROJECT_KEY_TAKEN',
          );
          return tx.project.create({
            data: { ...projectCreateFields(input), organizationId },
            select: PROJECT_SELECT,
          });
        }),
        projectUnique,
        'PROJECT_KEY_TAKEN',
        'TEAM_NOT_FOUND',
      );
    },

    /** Returns null when the project is not live in this organization. The key is immutable. */
    update(
      organizationId: string,
      projectId: string,
      input: UpdateProjectInput,
    ): Promise<ProjectRecord | null> {
      return mapErrors(
        run(organizationId, async (tx) => {
          if (!isUuid(projectId)) return null;
          const live = await tx.project.count({
            where: { organizationId, id: projectId, deletedAt: null },
          });
          if (live !== 1) return null;
          if (
            typeof input.teamId === 'string' &&
            !(await liveTeamExists(tx, organizationId, input.teamId))
          ) {
            throw new DirectoryError('TEAM_NOT_FOUND');
          }
          const { name, description, status, teamId } = input;
          return tx.project.update({
            where: { organizationId_id: { organizationId, id: projectId } },
            data: defined({ name, description, status, teamId }),
            select: PROJECT_SELECT,
          });
        }),
        projectUnique,
        'PROJECT_KEY_TAKEN',
        'TEAM_NOT_FOUND',
      );
    },

    /** Soft delete. The key stays reserved. */
    softDelete(organizationId: string, projectId: string): Promise<boolean> {
      return run(organizationId, async (tx) => {
        if (!isUuid(projectId)) return false;
        const r = await tx.project.updateMany({
          where: { organizationId, id: projectId, deletedAt: null },
          data: { deletedAt: new Date() },
        });
        return r.count === 1;
      });
    },
  };
}

export type EmployeeRepository = ReturnType<typeof createEmployeeRepository>;
export type TeamRepository = ReturnType<typeof createTeamRepository>;
export type TeamMemberRepository = ReturnType<typeof createTeamMemberRepository>;
export type ProjectRepository = ReturnType<typeof createProjectRepository>;
