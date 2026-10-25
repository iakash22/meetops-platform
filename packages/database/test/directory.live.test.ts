/**
 * Directory repositories (DB-2): employees, teams, team members and projects.
 * The live block runs as meetops_app (forced RLS) and is skipped unless RLS_TEST_APP_URL and
 * RLS_TEST_OWNER_URL point at a migrated database. Cursor helpers are unit-tested without a DB.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runWithOrganizationContext } from '../src/tenant.js';
import {
  DirectoryError,
  createEmployeeRepository,
  createProjectRepository,
  createTeamMemberRepository,
  createTeamRepository,
  isDirectoryError,
} from '../src/index.js';
import { decodeDirectoryCursor, encodeDirectoryCursor } from '../src/directory.js';

const APP_URL = process.env.RLS_TEST_APP_URL;
const OWNER_URL = process.env.RLS_TEST_OWNER_URL;

async function reasonOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (isDirectoryError(e)) return e.reason;
    throw e;
  }
  throw new Error('expected a DirectoryError');
}

describe('directory cursors', () => {
  it('round-trips (createdAt, id)', () => {
    const row = { createdAt: new Date('2026-10-25T10:00:00.123Z'), id: randomUUID() };
    expect(decodeDirectoryCursor(encodeDirectoryCursor(row))).toEqual(row);
  });

  it('rejects tampered, foreign or oversized cursors with INVALID_CURSOR', () => {
    for (const bad of [
      '',
      'not-a-cursor',
      Buffer.from('o:10').toString('base64url'),
      Buffer.from(`d1:2026-13-45T99:99:99.999Z|${randomUUID()}`).toString('base64url'),
      Buffer.from('d1:2026-10-25T10:00:00.000Z|nope').toString('base64url'),
      'A'.repeat(513),
    ]) {
      expect(() => decodeDirectoryCursor(bad), bad).toThrow(DirectoryError);
    }
    try {
      decodeDirectoryCursor('x');
    } catch (e) {
      expect(e).toMatchObject({ reason: 'INVALID_CURSOR', kind: 'invalid' });
    }
  });
});

describe.skipIf(!APP_URL || !OWNER_URL)('directory repositories (live, forced RLS)', () => {
  const app = new PrismaClient({ datasources: { db: { url: APP_URL ?? '' } } });
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL ?? '' } } });
  const employees = createEmployeeRepository({ client: app });
  const teams = createTeamRepository({ client: app });
  const members = createTeamMemberRepository({ client: app });
  const projects = createProjectRepository({ client: app });
  const orgA = randomUUID();
  const orgB = randomUUID();
  const userA = randomUUID();
  const userB = randomUUID();
  const sfx = orgA.slice(0, 8);

  beforeAll(async () => {
    await owner.organization.createMany({
      data: [
        { id: orgA, name: 'Dir A', slug: `dir-a-${orgA}` },
        { id: orgB, name: 'Dir B', slug: `dir-b-${orgB}` },
      ],
    });
    await owner.user.createMany({
      data: [
        { id: userA, email: `dir-a-${sfx}@example.test` },
        { id: userB, email: `dir-b-${sfx}@example.test` },
      ],
    });
    await runWithOrganizationContext(owner, orgA, (tx) =>
      tx.membership.create({ data: { organizationId: orgA, userId: userA, role: 'admin' } }),
    );
    await runWithOrganizationContext(owner, orgB, (tx) =>
      tx.membership.create({ data: { organizationId: orgB, userId: userB } }),
    );
  });

  afterAll(async () => {
    await owner.organization
      .deleteMany({ where: { id: { in: [orgA, orgB] } } })
      .catch(() => undefined);
    await owner.user.deleteMany({ where: { id: { in: [userA, userB] } } }).catch(() => undefined);
    await app.$disconnect();
    await owner.$disconnect();
  });

  describe('employees', () => {
    it('creates, reads, updates and soft-deletes within the org', async () => {
      const e = await employees.create(orgA, {
        fullName: 'Ada Lovelace',
        email: `ada-${sfx}@a.test`,
      });
      expect(e).toMatchObject({ organizationId: orgA, userId: null, title: null });
      expect(await employees.get(orgA, e.id)).toEqual(e);
      const u = await employees.update(orgA, e.id, { title: 'Engineer', email: null });
      expect(u).toMatchObject({ title: 'Engineer', email: null, fullName: 'Ada Lovelace' });
      expect(await employees.softDelete(orgA, e.id)).toBe(true);
      expect(await employees.get(orgA, e.id)).toBeNull();
      expect(await employees.update(orgA, e.id, { title: 'x' })).toBeNull();
      expect(await employees.softDelete(orgA, e.id)).toBe(false);
    });

    it('an org-B id read, updated or deleted under org-A context is null/false', async () => {
      const b = await employees.create(orgB, { fullName: 'Bob B' });
      expect(await employees.get(orgA, b.id)).toBeNull();
      expect(await employees.update(orgA, b.id, { fullName: 'pwned' })).toBeNull();
      expect(await employees.softDelete(orgA, b.id)).toBe(false);
      expect(await employees.get(orgB, b.id)).toMatchObject({ fullName: 'Bob B' });
      expect(await employees.get(orgA, 'not-a-uuid')).toBeNull();
    });

    it('rejects a userId that is not a member of the org, and duplicate email/user', async () => {
      expect(await reasonOf(employees.create(orgA, { fullName: 'X', userId: userB }))).toBe(
        'USER_NOT_MEMBER',
      );
      await employees.create(orgA, { fullName: 'Dup', email: `dup-${sfx}@a.test`, userId: userA });
      expect(
        await reasonOf(employees.create(orgA, { fullName: 'Dup2', email: `dup-${sfx}@a.test` })),
      ).toBe('EMPLOYEE_EMAIL_TAKEN');
      expect(await reasonOf(employees.create(orgA, { fullName: 'Dup3', userId: userA }))).toBe(
        'EMPLOYEE_USER_TAKEN',
      );
      const other = await employees.create(orgA, {
        fullName: 'Other',
        email: `other-${sfx}@a.test`,
      });
      expect(
        await employees.update(orgA, other.id, { email: `other-${sfx}@a.test` }),
      ).toMatchObject({
        fullName: 'Other',
      });
      expect(await reasonOf(employees.update(orgA, other.id, { email: `dup-${sfx}@a.test` }))).toBe(
        'EMPLOYEE_EMAIL_TAKEN',
      );
      expect(await reasonOf(employees.update(orgA, other.id, { userId: userA }))).toBe(
        'EMPLOYEE_USER_TAKEN',
      );
      expect(await reasonOf(employees.update(orgA, other.id, { userId: userB }))).toBe(
        'USER_NOT_MEMBER',
      );
      // the same email is fine in another org
      await expect(
        employees.create(orgB, { fullName: 'Dup', email: `dup-${sfx}@a.test` }),
      ).resolves.toBeTruthy();
    });

    it('pages with a cursor, hides soft-deleted rows, never shows other orgs, and searches', async () => {
      const org = randomUUID();
      await owner.organization.create({ data: { id: org, name: 'Pg', slug: `pg-${org}` } });
      try {
        const made = [];
        for (let i = 0; i < 5; i += 1)
          made.push(await employees.create(org, { fullName: `Person ${i}` }));
        await employees.softDelete(org, made[2]!.id);
        const seen: string[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          const page = await employees.list(org, { limit: 2, ...(cursor ? { cursor } : {}) });
          seen.push(...page.items.map((x) => x.fullName));
          for (const it of page.items) expect(it.organizationId).toBe(org);
          cursor = page.nextCursor ?? undefined;
          pages += 1;
        } while (cursor);
        expect(seen).toEqual(['Person 0', 'Person 1', 'Person 3', 'Person 4']);
        expect(pages).toBe(2);
        expect((await employees.list(org, { q: 'person 4' })).items.map((x) => x.fullName)).toEqual(
          ['Person 4'],
        );
        expect(await reasonOf(employees.list(org, { cursor: 'garbage' }))).toBe('INVALID_CURSOR');
        await expect(employees.list(org, { limit: 101 })).rejects.toThrow(RangeError);
      } finally {
        await owner.organization.delete({ where: { id: org } });
      }
    });
  });

  describe('teams and members', () => {
    it('team CRUD, duplicate name, and cross-org reads are null', async () => {
      const t = await teams.create(orgA, { name: `Ops ${sfx}`, key: 'OPS' });
      expect(t).toMatchObject({ organizationId: orgA, key: 'OPS', description: null });
      expect(await reasonOf(teams.create(orgA, { name: `Ops ${sfx}` }))).toBe('TEAM_NAME_TAKEN');
      await expect(teams.create(orgB, { name: `Ops ${sfx}` })).resolves.toBeTruthy();
      expect(await teams.get(orgB, t.id)).toBeNull();
      const t2 = await teams.create(orgA, { name: `Ops two ${sfx}` });
      expect(await reasonOf(teams.update(orgA, t2.id, { name: `Ops ${sfx}` }))).toBe(
        'TEAM_NAME_TAKEN',
      );
      expect(await teams.update(orgA, t2.id, { name: `Ops two ${sfx}` })).toMatchObject({
        id: t2.id,
      });
      expect(await teams.update(orgB, t.id, { name: 'x' })).toBeNull();
      expect(await teams.softDelete(orgB, t.id)).toBe(false);
      expect(
        await teams.update(orgA, t.id, { description: 'Runs things', key: null }),
      ).toMatchObject({
        description: 'Runs things',
        key: null,
      });
      expect((await teams.list(orgA, { q: 'ops' })).items.map((x) => x.id)).toContain(t.id);
      expect((await teams.list(orgB)).items.map((x) => x.id)).not.toContain(t.id);
    });

    it('adds, lists, updates and removes members with typed errors', async () => {
      const t = await teams.create(orgA, { name: `Core ${sfx}` });
      const e1 = await employees.create(orgA, { fullName: 'Lead One' });
      const e2 = await employees.create(orgA, { fullName: 'Member Two' });
      const eB = await employees.create(orgB, { fullName: 'Other Org' });
      const tB = await teams.create(orgB, { name: `Core B ${sfx}` });

      const m1 = await members.add(orgA, t.id, e1.id, 'lead');
      expect(m1).toMatchObject({
        teamId: t.id,
        employeeId: e1.id,
        role: 'lead',
        employee: { fullName: 'Lead One' },
      });
      await members.add(orgA, t.id, e2.id);
      expect(await reasonOf(members.add(orgA, t.id, e1.id))).toBe('TEAM_MEMBER_EXISTS');
      expect(await reasonOf(members.add(orgA, t.id, eB.id))).toBe('EMPLOYEE_NOT_FOUND');
      expect(await reasonOf(members.add(orgA, tB.id, e1.id))).toBe('TEAM_NOT_FOUND');
      expect(await reasonOf(members.add(orgA, randomUUID(), e1.id))).toBe('TEAM_NOT_FOUND');

      const page = await members.list(orgA, t.id);
      expect(page?.items.map((m) => m.employeeId)).toEqual([e1.id, e2.id]);
      expect((await members.list(orgA, t.id, { role: 'lead' }))?.items).toHaveLength(1);
      expect(await members.list(orgB, t.id)).toBeNull();
      expect(await members.get(orgB, t.id, e1.id)).toBeNull();
      expect(await members.updateRole(orgB, t.id, e1.id, 'member')).toBeNull();
      expect(await members.remove(orgB, t.id, e1.id)).toBe(false);

      expect(await members.updateRole(orgA, t.id, e2.id, 'lead')).toMatchObject({ role: 'lead' });
      await employees.softDelete(orgA, e2.id);
      expect((await members.list(orgA, t.id))?.items.map((m) => m.employeeId)).toEqual([e1.id]);
      expect(await members.get(orgA, t.id, e2.id)).toBeNull();

      expect(await members.remove(orgA, t.id, e1.id)).toBe(true);
      expect(await members.remove(orgA, t.id, e1.id)).toBe(false);

      await teams.softDelete(orgA, t.id);
      expect(await teams.get(orgA, t.id)).toBeNull();
      expect(await members.list(orgA, t.id)).toBeNull();
      expect(await reasonOf(members.add(orgA, t.id, e1.id))).toBe('TEAM_NOT_FOUND');
    });
  });

  describe('projects', () => {
    it('a duplicate project key maps to PROJECT_KEY_TAKEN, even after soft delete', async () => {
      const p = await projects.create(orgA, {
        name: 'Apollo',
        key: `AP${sfx.slice(0, 4).toUpperCase()}`,
      });
      expect(p).toMatchObject({ status: 'active', teamId: null, description: null });
      const err = await projects
        .create(orgA, { name: 'Again', key: p.key })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(DirectoryError);
      expect(err).toMatchObject({ reason: 'PROJECT_KEY_TAKEN', kind: 'conflict' });
      await projects.softDelete(orgA, p.id);
      expect(await reasonOf(projects.create(orgA, { name: 'Third', key: p.key }))).toBe(
        'PROJECT_KEY_TAKEN',
      );
      // keys are per organization
      await expect(projects.create(orgB, { name: 'Apollo B', key: p.key })).resolves.toBeTruthy();
    });

    it('an org-B project read under org-A context returns null; writes are no-ops', async () => {
      const pB = await projects.create(orgB, { name: 'Secret', key: 'SEC1' });
      expect(await projects.get(orgA, pB.id)).toBeNull();
      expect(await projects.update(orgA, pB.id, { name: 'pwned' })).toBeNull();
      expect(await projects.softDelete(orgA, pB.id)).toBe(false);
      expect((await projects.list(orgA)).items.map((x) => x.id)).not.toContain(pB.id);
      expect(await projects.get(orgB, pB.id)).toMatchObject({ name: 'Secret' });
    });

    it('team links: other-org or deleted team is TEAM_NOT_FOUND; filters by team/status/q', async () => {
      const tA = await teams.create(orgA, { name: `Proj team ${sfx}` });
      const tB = await teams.create(orgB, { name: `Proj team B ${sfx}` });
      expect(await reasonOf(projects.create(orgA, { name: 'x', key: 'XB1', teamId: tB.id }))).toBe(
        'TEAM_NOT_FOUND',
      );
      const p = await projects.create(orgA, { name: 'Gemini', key: 'GEM1', teamId: tA.id });
      expect(p.teamId).toBe(tA.id);
      expect(await reasonOf(projects.update(orgA, p.id, { teamId: tB.id }))).toBe('TEAM_NOT_FOUND');
      expect((await projects.list(orgA, { teamId: tA.id })).items.map((x) => x.id)).toEqual([p.id]);
      const archived = await projects.update(orgA, p.id, {
        status: 'archived',
        description: 'done',
      });
      expect(archived).toMatchObject({ status: 'archived', key: 'GEM1', description: 'done' });
      expect(
        (await projects.list(orgA, { status: 'archived', q: 'gem' })).items.map((x) => x.id),
      ).toEqual([p.id]);
      expect(
        (await projects.list(orgA, { status: 'active' })).items.map((x) => x.id),
      ).not.toContain(p.id);
      expect(await projects.update(orgA, p.id, { teamId: null })).toMatchObject({ teamId: null });
      await teams.softDelete(orgA, tA.id);
      expect(await reasonOf(projects.update(orgA, p.id, { teamId: tA.id }))).toBe('TEAM_NOT_FOUND');
    });

    it('RLS still holds underneath: no org context sees no directory rows', async () => {
      expect(await app.project.count()).toBe(0);
      expect(await app.team.count()).toBe(0);
      expect(await app.employee.count()).toBe(0);
      expect(await app.teamMember.count()).toBe(0);
    });
  });
});
