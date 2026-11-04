/**
 * Live tests for task_sync_jobs (async task -> GitHub/Jira sync): idempotent requests under concurrency, the
 * single-winner queued -> creating transition, the link written with `succeeded`, and forced-RLS isolation.
 * Runs as meetops_app. Skipped unless RLS_TEST_APP_URL and RLS_TEST_OWNER_URL point at a migrated database.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runWithOrganizationContext } from '../src/tenant.js';
import { createTaskSyncRepository } from '../src/index.js';

const APP_URL = process.env.RLS_TEST_APP_URL;
const OWNER_URL = process.env.RLS_TEST_OWNER_URL;

describe.skipIf(!APP_URL || !OWNER_URL)('task_sync_jobs (live)', () => {
  const app = new PrismaClient({
    datasources: {
      db: {
        url: `${APP_URL ?? ''}${(APP_URL ?? '').includes('?') ? '&' : '?'}connection_limit=12`,
      },
    },
  });
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL ?? '' } } });
  const repo = createTaskSyncRepository({ client: app });
  const orgA = randomUUID();
  const orgB = randomUUID();
  type Fx = { taskId: string; integrationId: string; approvalId: string };
  const fx = new Map<string, Fx>();

  async function fixture(organizationId: string): Promise<Fx> {
    return runWithOrganizationContext(owner, organizationId, async (tx) => {
      const user = await tx.user.create({
        data: { email: `u-${randomUUID()}@example.com`, name: 'U' },
      });
      const meeting = await tx.meeting.create({ data: { organizationId, title: 'sync test' } });
      const report = await tx.report.create({
        data: { organizationId, meetingId: meeting.id },
      });
      const extracted = await tx.extractedTask.create({
        data: { organizationId, meetingId: meeting.id, reportId: report.id, title: 'Ship it' },
      });
      const approval = await tx.taskApproval.create({
        data: {
          organizationId,
          extractedTaskId: extracted.id,
          reviewerId: user.id,
          decision: 'approved',
        },
      });
      const task = await tx.task.create({
        data: {
          organizationId,
          title: 'Ship it',
          extractedTaskId: extracted.id,
          meetingId: meeting.id,
        },
      });
      const conn = await tx.integrationConnection.create({
        data: {
          organizationId,
          provider: 'github',
          displayName: 'acme',
          externalAccountId: `inst-${randomUUID()}`,
          connectedById: user.id,
          tokenKeyId: 'k1',
          status: 'active',
          // CHECK needs v1 envelopes for an active row; fixture values only, no real secrets.
          accessTokenEnc: 'v1.fixture.wrapped.ciphertext',
          webhookSecretEnc: 'v1.fixture.wrapped.ciphertext',
        } as never,
      });
      return { taskId: task.id, integrationId: conn.id, approvalId: approval.id };
    });
  }

  beforeAll(async () => {
    await owner.organization.createMany({
      data: [
        { id: orgA, name: 'Sync A', slug: `sync-a-${orgA}` },
        { id: orgB, name: 'Sync B', slug: `sync-b-${orgB}` },
      ],
    });
    fx.set(orgA, await fixture(orgA));
    fx.set(orgB, await fixture(orgB));
  });

  afterAll(async () => {
    await owner.organization
      .deleteMany({ where: { id: { in: [orgA, orgB] } } })
      .catch(() => undefined);
    await app.$disconnect();
    await owner.$disconnect();
  });

  const input = (o: string) => ({ ...fx.get(o)!, provider: 'github' as const, target: 'acme/app' });

  it('concurrent requests resolve to one row', async () => {
    const rs = await Promise.all(Array.from({ length: 8 }, () => repo.request(orgA, input(orgA))));
    expect(new Set(rs.map((r) => r.job.id)).size).toBe(1);
    expect(rs.filter((r) => r.created)).toHaveLength(1);
  });

  it('queued -> creating has exactly one winner; succeed writes the link atomically', async () => {
    const { job } = await repo.request(orgA, input(orgA));
    const wins = await Promise.all(Array.from({ length: 6 }, () => repo.begin(orgA, job.id)));
    expect(wins.filter(Boolean)).toHaveLength(1);
    expect(
      await repo.succeed(orgA, job.id, {
        externalId: 'acme/app#5',
        externalUrl: 'https://github.com/acme/app/issues/5',
      }),
    ).toBe(true);
    expect(await repo.succeed(orgA, job.id, { externalId: 'acme/app#6' })).toBe(false);
    const row = await repo.get(orgA, job.id);
    expect(row).toMatchObject({ status: 'succeeded', attempts: 1, externalId: 'acme/app#5' });
    const links = await runWithOrganizationContext(app, orgA, (tx) =>
      tx.integrationIssue.findMany({ where: { taskId: job.taskId } }),
    );
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      externalId: 'acme/app#5',
      externalUrl: 'https://github.com/acme/app/issues/5',
    });
    // A repeat request returns the finished row unchanged.
    expect((await repo.request(orgA, input(orgA))).created).toBe(false);
  });

  it('failed rows are re-queued by a new request; needs_reconcile is not', async () => {
    const { job } = await repo.request(orgB, input(orgB));
    await repo.begin(orgB, job.id);
    await repo.finish(orgB, job.id, 'failed', 'PROVIDER_REJECTED_422');
    const again = await repo.request(orgB, input(orgB));
    expect(again).toMatchObject({ created: true, job: { status: 'queued' } });
    await repo.begin(orgB, job.id);
    await repo.finish(orgB, job.id, 'needs_reconcile', 'AMBIGUOUS_PROVIDER_ERROR');
    expect((await repo.request(orgB, input(orgB))).job.status).toBe('needs_reconcile');
  });

  it('cross-org: org B cannot read, start or finish org A rows; nothing without context', async () => {
    const a = (await repo.request(orgA, input(orgA))).job;
    expect(await repo.get(orgB, a.id)).toBeNull();
    expect(await repo.findByTask(orgB, a.taskId, a.integrationId)).toBeNull();
    expect(await repo.begin(orgB, a.id)).toBe(false);
    expect(await repo.finish(orgB, a.id, 'failed', 'X')).toBe(false);
    expect(await repo.reject(orgB, a.id, 'X')).toBe(false);
    // Org B cannot create a row pointing at org A's task (composite FKs + WITH CHECK).
    await expect(repo.request(orgB, { ...input(orgA) })).rejects.toThrow();
    expect(await app.$queryRaw<unknown[]>`SELECT 1 FROM "task_sync_jobs"`).toHaveLength(0);
  });

  it('meetops_app cannot delete sync rows', async () => {
    await expect(
      runWithOrganizationContext(app, orgA, (tx) => tx.$executeRaw`DELETE FROM "task_sync_jobs"`),
    ).rejects.toThrow();
  });
});
