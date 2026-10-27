import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatabaseClient } from '../src/shared/prisma/context.js';
import { PrismaTasks } from '../src/modules/tasks/prisma.repository.js';
import {
  TaskAssigneeInvalid,
  TaskMissing,
  TaskReferenceInvalid,
} from '../src/modules/tasks/ports.js';

/**
 * Unit tests for the tasks Prisma adapter without Postgres: withOrganizationContext is replaced by a spy that
 * records the org and hands the callback a fake transaction. The live RLS round trip needs Docker (see PR).
 */
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
const USER = '00000000-0000-4000-8000-000000000002';
const ID = '00000000-0000-4000-8000-000000000003';
const at = new Date('2026-10-27T00:00:00.000Z');
const row = {
  id: ID,
  organizationId: ORG,
  projectId: null,
  meetingId: null,
  extractedTaskId: null,
  title: 'x',
  description: null,
  status: 'todo',
  priority: 'medium',
  assigneeId: null,
  dueAt: null,
  createdAt: at,
  updatedAt: at,
};

describe('PrismaTasks adapter', () => {
  const repo = new PrismaTasks({ fake: 'prisma' } as unknown as DatabaseClient);
  beforeEach(() => {
    h.orgs.length = 0;
    h.tx = {
      task: {
        create: vi.fn().mockResolvedValue(row),
        findFirst: vi.fn().mockResolvedValue(null),
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      employee: { findFirst: vi.fn().mockResolvedValue(null) },
      project: { findFirst: vi.fn().mockResolvedValue(null) },
      meeting: { findFirst: vi.fn().mockResolvedValue(null) },
    };
  });

  it('creates inside the org context with the org id and creator set', async () => {
    const t = await repo.createTask(ORG, {
      createdById: USER,
      title: 'x',
      status: 'todo',
      priority: 'medium',
    });
    expect(h.orgs).toEqual([ORG]);
    expect(t).toMatchObject({ id: ID, organizationId: ORG, status: 'todo' });
    expect(h.tx.task!.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ organizationId: ORG, createdById: USER, assigneeId: null }),
    });
  });

  it('checks references against live rows of the same org before inserting', async () => {
    const base = { createdById: USER, title: 'x', status: 'todo', priority: 'low' } as const;
    await expect(repo.createTask(ORG, { ...base, assigneeId: ID })).rejects.toBeInstanceOf(
      TaskAssigneeInvalid,
    );
    await expect(repo.createTask(ORG, { ...base, projectId: ID })).rejects.toEqual(
      new TaskReferenceInvalid('projectId'),
    );
    await expect(repo.createTask(ORG, { ...base, meetingId: ID })).rejects.toEqual(
      new TaskReferenceInvalid('meetingId'),
    );
    for (const m of ['employee', 'project', 'meeting'])
      expect(h.tx[m]!.findFirst).toHaveBeenCalledWith({
        where: { organizationId: ORG, id: ID, deletedAt: null },
        select: { id: true },
      });
    expect(h.tx.task!.create).not.toHaveBeenCalled();
  });

  it('get and update ignore soft-deleted tasks', async () => {
    await expect(repo.getTask(ORG, ID)).rejects.toBeInstanceOf(TaskMissing);
    expect(h.tx.task!.findFirst).toHaveBeenCalledWith({
      where: { organizationId: ORG, id: ID, deletedAt: null },
    });
    await expect(repo.updateTask(ORG, ID, { title: 'y' })).rejects.toBeInstanceOf(TaskMissing);
    expect(h.tx.task!.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: ORG, id: ID, deletedAt: null } }),
    );
  });
});
