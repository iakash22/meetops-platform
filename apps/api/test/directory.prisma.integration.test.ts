/**
 * BE-3 directory routes over the DB-2 Prisma repositories against live Postgres (forced RLS, meetops_app
 * role). Skipped unless TEST_DATABASE_URL is set, like prisma.integration.test.ts:
 *   TEST_DATABASE_URL=postgresql://meetops_app:...@127.0.0.1:5432/meetops pnpm vitest run test/directory.prisma.integration.test.ts
 * The schema must be migrated with the directory tables (DB-1, #126).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createPrismaClient, withOrgContext, type DatabaseClient } from '@meetops/database';
import { buildApp, signupAndLogin, type App } from './helpers.js';
import { PrismaUserRepository } from '../src/modules/users/infrastructure/prisma/prisma-user.repository.js';
import { PrismaSessionRepository } from '../src/modules/auth/infrastructure/prisma/prisma-session.repository.js';
import { PrismaAuditLog } from '../src/modules/auth/infrastructure/prisma/prisma-audit.log.js';
import { PrismaOneTimeTokenRepository } from '../src/modules/auth/infrastructure/prisma/prisma-one-time-token.repository.js';
import {
  PrismaInvitationRepository,
  PrismaMembershipRepository,
  PrismaOrganizationRepository,
} from '../src/modules/organizations/infrastructure/prisma/prisma.repositories.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)(
  'BE-3 directory over DB-2 Prisma repositories (live RLS)',
  { timeout: 60_000 },
  () => {
    let db: DatabaseClient;
    let app: App;
    const sfx = randomUUID().slice(0, 8);
    const email = (n: string) => `${n}-${sfx}@example.com`;

    beforeAll(async () => {
      db = createPrismaClient({ databaseUrl: url! });
      app = await buildApp({
        db, // no injected `directory`: the module must pick the DB-2 repositories from deps.db
        users: new PrismaUserRepository(db),
        sessions: new PrismaSessionRepository(db),
        organizations: new PrismaOrganizationRepository(db),
        memberships: new PrismaMembershipRepository(db),
        invitations: new PrismaInvitationRepository(db),
        audit: new PrismaAuditLog(db),
        oneTimeTokens: new PrismaOneTimeTokenRepository(db),
        rateLimiter: { consume: () => Promise.resolve({ allowed: true, retryAfterMs: 0 }) },
      });
    });
    afterAll(async () => {
      await app?.close();
      await db?.$disconnect();
    });

    it('CRUD, conflicts with reasons, cross-org 404 and audit rows', async () => {
      const owner = await signupAndLogin(app, email('owner'));
      const org = (await owner.post('/orgs', { name: `Dir ${sfx}` })).json<{
        organization: { id: string };
      }>().organization.id;
      const base = `/orgs/${org}`;

      const emp = await owner.post(`${base}/employees`, { fullName: 'Ada', email: email('ada') });
      expect(emp.statusCode).toBe(201);
      const empId = emp.json<{ id: string }>().id;
      const dupe = await owner.post(`${base}/employees`, {
        fullName: 'Ada 2',
        email: email('ada'),
      });
      expect(dupe.statusCode).toBe(409);

      const team = await owner.post(`${base}/teams`, { name: 'Core' });
      expect(team.statusCode).toBe(201);
      const teamId = team.json<{ id: string }>().id;
      expect(
        (await owner.post(`${base}/teams/${teamId}/members`, { employeeId: empId })).statusCode,
      ).toBe(201);
      const again = await owner.post(`${base}/teams/${teamId}/members`, { employeeId: empId });
      expect(again.statusCode).toBe(409);
      expect(again.json<{ error: { reason: string } }>().error.reason).toBe('TEAM_MEMBER_EXISTS');

      const key = `K${sfx
        .slice(0, 4)
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, 'X')}`;
      const project = await owner.post(`${base}/projects`, { name: 'Apollo', key, teamId });
      expect(project.statusCode).toBe(201);
      const projectId = project.json<{ id: string }>().id;
      const taken = await owner.post(`${base}/projects`, { name: 'Apollo 2', key });
      expect(taken.statusCode).toBe(409);
      expect(taken.json<{ error: { reason: string } }>().error.reason).toBe('PROJECT_KEY_TAKEN');

      const page = await owner.get(`${base}/employees?limit=1`);
      expect(page.statusCode).toBe(200);
      expect(page.json<{ items: unknown[] }>().items).toHaveLength(1);

      // Another org's member sees 404 for every id of this org, through RLS as well as the API gate.
      const other = await signupAndLogin(app, email('other'));
      const otherOrg = (await other.post('/orgs', { name: `Other ${sfx}` })).json<{
        organization: { id: string };
      }>().organization.id;
      for (const path of [`employees/${empId}`, `teams/${teamId}`, `projects/${projectId}`]) {
        expect((await other.get(`/orgs/${otherOrg}/${path}`)).statusCode).toBe(404);
        expect((await other.get(`${base}/${path}`)).statusCode).toBe(404);
      }

      // Deleting the team removes it from the project, and the key stays reserved after a delete.
      expect((await owner.delete(`${base}/teams/${teamId}`)).statusCode).toBe(204);
      expect(
        (await owner.get(`${base}/projects/${projectId}`)).json<{ teamId: string | null }>().teamId,
      ).toBeNull();
      expect((await owner.delete(`${base}/projects/${projectId}`)).statusCode).toBe(204);
      expect((await owner.post(`${base}/projects`, { name: 'Again', key })).statusCode).toBe(409);

      const rows = await withOrgContext(
        org,
        (tx) =>
          tx.auditEvent.findMany({ where: { organizationId: org }, select: { action: true } }),
        { client: db },
      );
      expect(rows.map((r) => r.action)).toEqual(
        expect.arrayContaining([
          'employee.create',
          'team.create',
          'team_member.add',
          'project.create',
          'team.delete',
          'project.delete',
        ]),
      );
    });
  },
);
