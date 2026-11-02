import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '../src/shared/prisma/context.js';
import { PrismaTasks } from '../src/modules/tasks/prisma.repository.js';

/** PrismaTasks.analytics without Postgres: one org-context transaction, explicit org filters, alphabetical output. */
const h = vi.hoisted(() => ({
  orgs: [] as string[],
  tx: {} as Record<string, Record<string, ReturnType<typeof vi.fn>>>,
}));
vi.mock('@meetops/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@meetops/database')>();
  return {
    ...actual,
    withOrganizationContext: (orgId: string, fn: (tx: unknown) => unknown) => {
      h.orgs.push(orgId);
      return fn(h.tx);
    },
  };
});

const ORG = '00000000-0000-4000-8000-000000000001';
const from = new Date('2026-10-01T00:00:00Z');
const to = new Date('2026-11-01T00:00:00Z');
const c = (n: number) => ({ _count: { _all: n } });

describe('PrismaTasks.analytics', () => {
  const repo = new PrismaTasks({ fake: 'prisma' } as unknown as DatabaseClient);
  beforeEach(() => {
    h.orgs.length = 0;
    h.tx = {
      task: {
        groupBy: vi.fn().mockResolvedValue([
          { status: 'todo', ...c(2) },
          { status: 'done', ...c(1) },
        ]),
      },
      extractedTask: {
        groupBy: vi.fn().mockResolvedValue([{ status: 'pending_review', ...c(4) }]),
      },
      taskApproval: {
        groupBy: vi.fn().mockResolvedValue([
          { decision: 'rejected', ...c(1) },
          { decision: 'approved', ...c(3) },
        ]),
      },
    };
  });

  it('runs in one org context with explicit org, window and soft-delete filters', async () => {
    const r = await repo.analytics(ORG, { from, to });
    expect(h.orgs).toEqual([ORG]);
    const createdAt = { gte: from, lt: to };
    expect(h.tx.task!.groupBy).toHaveBeenCalledWith({
      by: ['status'],
      where: { organizationId: ORG, deletedAt: null, createdAt },
      _count: { _all: true },
    });
    expect(h.tx.extractedTask!.groupBy).toHaveBeenCalledWith({
      by: ['status'],
      where: { organizationId: ORG, deletedAt: null, createdAt },
      _count: { _all: true },
    });
    expect(h.tx.taskApproval!.groupBy).toHaveBeenCalledWith({
      by: ['decision'],
      where: { organizationId: ORG, createdAt },
      _count: { _all: true },
    });
    expect(r).toEqual({
      tasks: {
        total: 3,
        byStatus: [
          { status: 'done', count: 1 },
          { status: 'todo', count: 2 },
        ],
      },
      extractedTasks: { total: 4, byStatus: [{ status: 'pending_review', count: 4 }] },
      approvals: {
        total: 4,
        byDecision: [
          { decision: 'approved', count: 3 },
          { decision: 'rejected', count: 1 },
        ],
      },
    });
  });
});
