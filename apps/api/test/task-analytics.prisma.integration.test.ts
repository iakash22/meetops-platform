/**
 * P7 task analytics over live Postgres (forced RLS, meetops_app role): cross-org isolation. Skipped unless
 * TEST_DATABASE_URL is set (TEST_OWNER_DATABASE_URL creates the orgs), like analytics.prisma.integration.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createPrismaClient,
  withOrganizationContext,
  type DatabaseClient,
} from '@meetops/database';
import { PrismaTasks } from '../src/modules/tasks/prisma.repository.js';

const url = process.env.TEST_DATABASE_URL;
const from = new Date('2026-10-01T00:00:00Z');
const to = new Date('2026-11-01T00:00:00Z');
const inRange = new Date('2026-10-02T10:00:00Z');

describe.skipIf(!url)('PrismaTasks.analytics (live RLS, cross-org)', { timeout: 60_000 }, () => {
  let db: DatabaseClient;
  const orgA = randomUUID();
  const orgB = randomUUID();
  const orgEmpty = randomUUID();

  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: url! });
    const owner = process.env.TEST_OWNER_DATABASE_URL;
    if (owner) {
      const o = createPrismaClient({ databaseUrl: owner });
      for (const id of [orgA, orgB, orgEmpty])
        await o.organization.create({
          data: { id, name: `TaskAn ${id.slice(0, 4)}`, slug: `task-an-${id.slice(0, 8)}` },
        });
      await o.$disconnect();
    }
    const seed = (
      org: string,
      tasks: ('todo' | 'done')[],
      decisions: ('approved' | 'rejected')[],
    ) =>
      withOrganizationContext(
        org,
        async (tx) => {
          for (const status of tasks)
            await tx.task.create({
              data: { organizationId: org, title: 't', status, createdAt: inRange },
            });
          await tx.task.create({
            data: { organizationId: org, title: 'gone', createdAt: inRange, deletedAt: inRange },
          });
          if (!decisions.length) return;
          const m = await tx.meeting.create({ data: { organizationId: org, title: 'm' } });
          const r = await tx.report.create({ data: { organizationId: org, meetingId: m.id } });
          for (const decision of decisions) {
            const e = await tx.extractedTask.create({
              data: {
                organizationId: org,
                meetingId: m.id,
                reportId: r.id,
                title: 'x',
                status: decision === 'approved' ? 'converted' : 'rejected',
                createdAt: inRange,
              },
            });
            await tx.taskApproval.create({
              data: { organizationId: org, extractedTaskId: e.id, decision, createdAt: inRange },
            });
          }
        },
        { client: db },
      );
    await seed(orgA, ['todo', 'todo', 'done'], ['approved']);
    await seed(orgB, ['done'], ['rejected', 'rejected']);
  });
  afterAll(async () => db?.$disconnect());

  it('counts only the caller org and is empty for an empty org', async () => {
    const repo = new PrismaTasks(db);
    expect(await repo.analytics(orgA, { from, to })).toEqual({
      tasks: {
        total: 3,
        byStatus: [
          { status: 'done', count: 1 },
          { status: 'todo', count: 2 },
        ],
      },
      extractedTasks: { total: 1, byStatus: [{ status: 'converted', count: 1 }] },
      approvals: { total: 1, byDecision: [{ decision: 'approved', count: 1 }] },
    });
    const b = await repo.analytics(orgB, { from, to });
    expect(b.tasks.total).toBe(1);
    expect(b.approvals).toEqual({ total: 2, byDecision: [{ decision: 'rejected', count: 2 }] });
    expect(await repo.analytics(orgEmpty, { from, to })).toEqual({
      tasks: { total: 0, byStatus: [] },
      extractedTasks: { total: 0, byStatus: [] },
      approvals: { total: 0, byDecision: [] },
    });
  });
});
