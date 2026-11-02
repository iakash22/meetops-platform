import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { ApiErrorEnvelope, TaskAnalytics, type ExtractedTask, type Task } from '@meetops/contracts';
import { InMemoryTasks } from '../src/modules/tasks/in-memory.repository.js';
import type { ModuleDeps } from '../src/modules/index.js';
import { buildApp, signupAndLogin, type App, type Client } from './helpers.js';

const FROM = '2026-10-01T00:00:00.000Z';
const TO = '2026-11-01T00:00:00.000Z';
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

describe('task and approval analytics (P7, read-only, org-scoped)', () => {
  let app: App;
  let repo: InMemoryTasks;
  beforeEach(async () => {
    repo = new InMemoryTasks();
    app = await buildApp({ tasks: repo } as Partial<ModuleDeps>);
  });
  afterEach(async () => app.close());

  const createOrg = async (c: Client, name: string) =>
    (await c.post('/orgs', { name })).json<{ organization: { id: string } }>().organization.id;
  async function join(owner: Client, orgId: string, email: string) {
    const c = await signupAndLogin(app, email);
    const inv = await owner.post(`/orgs/${orgId}/invitations`, { email, role: 'viewer' });
    expect(inv.statusCode).toBe(201);
    const sent = [...app.mail.sent].reverse().find((m) => m.template === 'invitation');
    const token = new URL(sent!.data.url!).searchParams.get('token')!;
    expect((await c.post('/invitations/accept', { token })).statusCode).toBe(200);
    expect((await c.post('/orgs/switch', { organizationId: orgId })).statusCode).toBe(200);
    return c;
  }
  const url = (org: string, q: Record<string, string> = { from: FROM, to: TO }) =>
    `/orgs/${org}/analytics/tasks?${new URLSearchParams(q).toString()}`;

  const task = (organizationId: string, status: Task['status'], createdAt: string) =>
    repo.tasks.push({
      id: uuid(),
      organizationId,
      title: 't',
      status,
      priority: 'medium',
      createdAt,
      updatedAt: createdAt,
    });
  const extracted = (org: string, createdAt: string): ExtractedTask => {
    const e: ExtractedTask = {
      id: uuid(),
      meetingId: uuid(),
      reportId: uuid(),
      title: 'x',
      sourceSegmentIds: [],
      createdAt,
    };
    repo.addExtracted(org, e);
    return e;
  };

  async function world() {
    const owner = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(owner, 'Acme');
    const viewer = await join(owner, org, 'viewer@example.com');
    const other = await signupAndLogin(app, 'other@example.com');
    const otherOrg = await createOrg(other, 'Globex');
    return { owner, org, viewer, other, otherOrg };
  }

  it('counts tasks, review states and approvals for the caller org and window only', async () => {
    const { owner, org, viewer, otherOrg } = await world();
    task(org, 'todo', '2026-10-02T00:00:00.000Z');
    task(org, 'todo', '2026-10-31T23:59:59.999Z');
    task(org, 'done', '2026-10-15T00:00:00.000Z');
    task(org, 'done', TO); // `to` is exclusive
    task(org, 'cancelled', '2026-09-30T23:59:59.999Z');
    task(otherOrg, 'in_progress', '2026-10-10T00:00:00.000Z');
    const e1 = extracted(org, '2026-10-03T00:00:00.000Z');
    const e2 = extracted(org, '2026-10-04T00:00:00.000Z');
    extracted(org, '2026-10-05T00:00:00.000Z');
    extracted(otherOrg, '2026-10-05T00:00:00.000Z');
    // Review in October: approvals get the review time from the clock.
    const at = { now: () => new Date('2026-10-20T00:00:00.000Z') };
    (repo as unknown as { now: () => Date }).now = at.now;
    const acc = await owner.post(`/orgs/${org}/extracted-tasks/${e1.id}/accept`, {
      title: 'Ship',
      priority: 'high',
    });
    expect(acc.statusCode).toBe(201);
    expect((await owner.post(`/orgs/${org}/extracted-tasks/${e2.id}/dismiss`)).statusCode).toBe(
      204,
    );

    const res = await viewer.get(url(org));
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('private, no-store');
    const body = res.json<TaskAnalytics>();
    expect(Value.Check(TaskAnalytics, body)).toBe(true);
    expect(body).toEqual({
      organizationId: org,
      from: FROM,
      to: TO,
      tasks: {
        total: 4, // 3 seeded in range + the accepted one (created 2026-10-20)
        byStatus: [
          { status: 'done', count: 1 },
          { status: 'todo', count: 3 },
        ],
      },
      extractedTasks: {
        total: 3,
        byStatus: [
          { status: 'converted', count: 1 },
          { status: 'pending_review', count: 1 },
          { status: 'rejected', count: 1 },
        ],
      },
      approvals: {
        total: 2,
        byDecision: [
          { decision: 'approved', count: 1 },
          { decision: 'rejected', count: 1 },
        ],
      },
    });
    expect(JSON.stringify(body)).not.toContain(e1.id);
  });

  it('is empty, not an error, for an org with no rows', async () => {
    const { org, owner } = await world();
    const body = (await owner.get(url(org))).json<TaskAnalytics>();
    expect(body.tasks).toEqual({ total: 0, byStatus: [] });
    expect(body.extractedTasks).toEqual({ total: 0, byStatus: [] });
    expect(body.approvals).toEqual({ total: 0, byDecision: [] });
  });

  it('cross-org: another org is 404 and leaks nothing; no session is 401', async () => {
    const { org, other, otherOrg } = await world();
    task(org, 'todo', '2026-10-02T00:00:00.000Z');
    const res = await other.get(url(org));
    expect(res.statusCode).toBe(404);
    expect(Value.Check(ApiErrorEnvelope, res.json())).toBe(true);
    const own = (await other.get(url(otherOrg))).json<TaskAnalytics>();
    expect(own.tasks.total).toBe(0);
    const anon = await app.inject({ method: 'GET', url: url(org) });
    expect(anon.statusCode).toBe(401);
  });

  it('rejects bad windows with 400 VALIDATION_FAILED (after the tenant gate)', async () => {
    const { org, owner, other } = await world();
    for (const q of [
      { from: TO, to: FROM },
      { from: FROM, to: FROM },
      { from: '2025-01-01T00:00:00.000Z', to: '2026-06-01T00:00:00.000Z' },
    ]) {
      const r = await owner.get(url(org, q));
      expect(r.statusCode).toBe(400);
      expect(r.json<{ error: { code: string } }>().error.code).toBe('VALIDATION_FAILED');
    }
    expect((await owner.get(url(org, { from: FROM }))).statusCode).toBe(400);
    expect((await other.get(url(org, { from: TO, to: FROM }))).statusCode).toBe(404);
  });
});
