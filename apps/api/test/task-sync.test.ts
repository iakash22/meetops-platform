import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Value } from '@sinclair/typebox/value';
import { TaskSyncJob, type TaskSyncJobPayload } from '@meetops/contracts';
import { InMemoryAuditLog } from '../src/modules/auth/domain/audit.js';
import { InMemoryIntegrations } from '../src/modules/integrations/in-memory.repository.js';
import { devIntegrationsRuntime } from '../src/modules/integrations/runtime.js';
import { selectTaskSync } from '../src/modules/integrations/index.js';
import {
  InMemoryTaskSyncStore,
  PrismaTaskSyncStore,
  taskSyncEnabled,
  taskSyncJobId,
  type TaskSyncQueue,
} from '../src/modules/integrations/task-sync.js';
import type { ModuleDeps } from '../src/modules/index.js';
import { buildApp, signupAndLogin, type App, type Client } from './helpers.js';

class FakeQueue implements TaskSyncQueue {
  readonly added: TaskSyncJobPayload[] = [];
  down = false;
  async enqueue(p: TaskSyncJobPayload) {
    if (this.down) throw new Error('ECONNREFUSED');
    this.added.push(p);
  }
}

const url = (org: string, taskId: string) => `/orgs/${org}/tasks/${taskId}/sync`;

describe('POST /orgs/:organizationId/tasks/:taskId/sync (TASK_SYNC_ENABLED)', () => {
  let app: App;
  let repo: InMemoryIntegrations;
  let store: InMemoryTaskSyncStore;
  let queue: FakeQueue;
  let audit: InMemoryAuditLog;

  async function boot(enabled: boolean) {
    repo = new InMemoryIntegrations();
    store = new InMemoryTaskSyncStore();
    queue = new FakeQueue();
    audit = new InMemoryAuditLog();
    app = await buildApp({
      integrations: repo,
      audit,
      integrationsRuntime: devIntegrationsRuntime(),
      taskSyncEnabled: enabled,
      taskSyncStore: store,
      taskSyncQueue: queue,
    } as Partial<ModuleDeps>);
  }
  afterEach(async () => app.close());

  const createOrg = async (c: Client, name: string) =>
    (await c.post('/orgs', { name })).json<{ organization: { id: string } }>().organization.id;

  async function setup(
    email = 'owner@example.com',
    opts: {
      provider?: 'github' | 'jira';
      decision?: 'approved' | 'rejected';
      manual?: boolean;
    } = {},
  ) {
    const provider = opts.provider ?? 'github';
    const c = await signupAndLogin(app, email);
    const org = await createOrg(c, `Org ${email}`);
    const integrationId = randomUUID();
    repo.add(
      {
        id: integrationId,
        organizationId: org,
        provider,
        status: 'active',
        displayName: provider === 'jira' ? 'acme.atlassian.net' : 'acme',
        externalAccountId: provider === 'jira' ? randomUUID() : '99',
        connectedById: randomUUID(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      { accessToken: 'tok', refreshToken: null, webhookSecret: 'w' },
      null,
    );
    const taskId = randomUUID();
    const extractedTaskId = randomUUID();
    repo.tasks.set(taskId, {
      id: taskId,
      organizationId: org,
      title: 'Ship it',
      description: 'desc',
      extractedTaskId: opts.manual ? null : extractedTaskId,
      status: 'todo',
    });
    const approvalId = randomUUID();
    repo.approvals.set(approvalId, {
      id: approvalId,
      organizationId: org,
      extractedTaskId,
      reviewerId: randomUUID(),
      decision: opts.decision ?? 'approved',
    });
    const body = {
      integrationId,
      approvalId,
      target: provider === 'github' ? 'acme/app' : 'OPS',
    };
    return { c, org, integrationId, taskId, approvalId, body };
  }

  describe('flag off (default)', () => {
    beforeEach(() => boot(false));
    it('the route is not registered', async () => {
      const s = await setup();
      expect((await s.c.post(url(s.org, s.taskId), s.body)).statusCode).toBe(404);
      expect(store.rows).toHaveLength(0);
      expect(queue.added).toHaveLength(0);
    });
  });

  describe('flag on', () => {
    beforeEach(() => boot(true));

    it('records the request, enqueues one job (ids only) and answers 202', async () => {
      const s = await setup();
      const r = await s.c.post(url(s.org, s.taskId), s.body);
      expect(r.statusCode).toBe(202);
      expect(Value.Check(TaskSyncJob, r.json())).toBe(true);
      expect(r.json()).toMatchObject({
        taskId: s.taskId,
        integrationId: s.integrationId,
        provider: 'github',
        status: 'queued',
        attempts: 0,
      });
      expect(queue.added).toEqual([{ jobVersion: 1, organizationId: s.org, syncId: r.json().id }]);
      expect(audit.events.some((e) => e.action === 'integration.task_sync_requested')).toBe(true);
    });

    it('is idempotent: repeats and concurrent duplicates map to one row and one job id', async () => {
      const s = await setup();
      const rs = await Promise.all(
        Array.from({ length: 5 }, () => s.c.post(url(s.org, s.taskId), s.body)),
      );
      const ids = new Set(rs.map((r) => r.json<{ id: string }>().id));
      expect(rs.every((r) => r.statusCode === 202)).toBe(true);
      expect(ids.size).toBe(1);
      expect(store.rows).toHaveLength(1);
      expect(new Set(queue.added.map(taskSyncJobId)).size).toBe(1);
      // A finished job is returned as is and not re-enqueued.
      Object.assign(store.rows[0]!, {
        status: 'succeeded',
        externalId: 'acme/app#5',
        externalUrl: 'https://github.com/acme/app/issues/5',
      });
      const before = queue.added.length;
      const done = await s.c.post(url(s.org, s.taskId), s.body);
      expect(done.statusCode).toBe(202);
      expect(done.json()).toMatchObject({ status: 'succeeded', externalId: 'acme/app#5' });
      expect(queue.added).toHaveLength(before);
    });

    it('a failed row is re-queued by a new request; needs_reconcile is never re-sent', async () => {
      const s = await setup();
      await s.c.post(url(s.org, s.taskId), s.body);
      store.rows[0]!.status = 'failed';
      const r = await s.c.post(url(s.org, s.taskId), s.body);
      expect(r.json()).toMatchObject({ status: 'queued' });
      store.rows[0]!.status = 'needs_reconcile';
      const n = queue.added.length;
      const r2 = await s.c.post(url(s.org, s.taskId), s.body);
      expect(r2.json()).toMatchObject({ status: 'needs_reconcile' });
      expect(queue.added).toHaveLength(n);
    });

    it('refuses unapproved, mismatched and manual (no extracted task) tasks with 403', async () => {
      const s = await setup('a@example.com', { decision: 'rejected' });
      expect((await s.c.post(url(s.org, s.taskId), s.body)).statusCode).toBe(403);
      repo.approvals.get(s.approvalId)!.decision = 'approved';
      repo.approvals.get(s.approvalId)!.extractedTaskId = randomUUID();
      expect((await s.c.post(url(s.org, s.taskId), s.body)).statusCode).toBe(403);
      const m = await setup('b@example.com', { manual: true });
      expect((await m.c.post(url(m.org, m.taskId), m.body)).statusCode).toBe(403);
      expect(store.rows).toHaveLength(0);
      expect(queue.added).toHaveLength(0);
    });

    it('validates the integration and target; no provider fallback', async () => {
      const s = await setup();
      expect((await s.c.post(url(s.org, s.taskId), { ...s.body, target: 'OPS' })).statusCode).toBe(
        400,
      );
      expect(
        (await s.c.post(url(s.org, s.taskId), { ...s.body, integrationId: randomUUID() }))
          .statusCode,
      ).toBe(404);
      repo.rows.get(s.integrationId)!.status = 'error';
      expect((await s.c.post(url(s.org, s.taskId), s.body)).statusCode).toBe(409);
      expect(queue.added).toHaveLength(0);
    });

    it('a task already linked by the synchronous push is 409', async () => {
      const s = await setup();
      await repo.createIssueLink(s.org, {
        taskId: s.taskId,
        integrationId: s.integrationId,
        provider: 'github',
        externalId: 'acme/app#1',
      });
      expect((await s.c.post(url(s.org, s.taskId), s.body)).statusCode).toBe(409);
      expect(store.rows).toHaveLength(0);
    });

    it('cross-org: another org cannot see or queue org A tasks (404)', async () => {
      const a = await setup('a@example.com');
      const b = await setup('b@example.com');
      // B on A's org path: not a member.
      expect((await b.c.post(url(a.org, a.taskId), a.body)).statusCode).toBe(404);
      // B on its own org path with A's task / integration ids.
      expect((await b.c.post(url(b.org, a.taskId), { ...b.body })).statusCode).toBe(404);
      expect(
        (await b.c.post(url(b.org, b.taskId), { ...b.body, integrationId: a.integrationId }))
          .statusCode,
      ).toBe(404);
      expect(
        (await b.c.post(url(b.org, b.taskId), { ...b.body, approvalId: a.approvalId })).statusCode,
      ).toBe(403);
      expect(store.rows).toHaveLength(0);
      expect(queue.added).toHaveLength(0);
    });

    it('queue down: 503, the row stays queued and the next request enqueues it', async () => {
      const s = await setup();
      queue.down = true;
      expect((await s.c.post(url(s.org, s.taskId), s.body)).statusCode).toBe(503);
      expect(store.rows[0]!.status).toBe('queued');
      queue.down = false;
      expect((await s.c.post(url(s.org, s.taskId), s.body)).statusCode).toBe(202);
      expect(queue.added).toHaveLength(1);
      expect(store.rows).toHaveLength(1);
    });

    it('members cannot request a sync', async () => {
      const s = await setup();
      const m = await signupAndLogin(app, 'm@example.com');
      await s.c.post(`/orgs/${s.org}/invitations`, { email: 'm@example.com', role: 'member' });
      const sent = [...app.mail.sent].reverse().find((x) => x.template === 'invitation');
      await m.post('/invitations/accept', {
        token: new URL(sent!.data.url!).searchParams.get('token')!,
      });
      await m.post('/orgs/switch', { organizationId: s.org });
      expect((await m.post(url(s.org, s.taskId), s.body)).statusCode).toBe(403);
      expect(queue.added).toHaveLength(0);
    });
  });
});

describe('task sync config', () => {
  it('TASK_SYNC_ENABLED is off by default and must be a boolean', () => {
    expect(taskSyncEnabled({})).toBe(false);
    expect(taskSyncEnabled({ TASK_SYNC_ENABLED: 'true' })).toBe(true);
    expect(() => taskSyncEnabled({ TASK_SYNC_ENABLED: 'maybe' })).toThrow();
  });

  it('never silently in-memory in production; requires REDIS_URL', () => {
    expect(selectTaskSync({} as never, {})).toBeUndefined();
    expect(() =>
      selectTaskSync({} as never, {
        TASK_SYNC_ENABLED: 'true',
        NODE_ENV: 'production',
        REDIS_URL: 'redis://x',
      }),
    ).toThrow();
    expect(() =>
      selectTaskSync({} as never, { TASK_SYNC_ENABLED: 'true', NODE_ENV: 'test' }),
    ).toThrow(/REDIS_URL/);
    const q = { enqueue: async () => undefined };
    const s = selectTaskSync({ db: {} as never, taskSyncQueue: q } as never, {
      TASK_SYNC_ENABLED: 'true',
      NODE_ENV: 'production',
    });
    expect(s?.store).toBeInstanceOf(PrismaTaskSyncStore);
  });
});
