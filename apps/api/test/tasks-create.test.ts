import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { CursorPage, Task } from '@meetops/contracts';
import { InMemoryTasks } from '../src/modules/tasks/in-memory.repository.js';
import { InMemoryAuditLog } from '../src/modules/auth/domain/audit.js';
import type { ModuleDeps } from '../src/modules/index.js';
import { buildApp, signupAndLogin, type App, type Client } from './helpers.js';

const EMP = '00000000-0000-4000-8000-0000000003b1';
const PROJ = '00000000-0000-4000-8000-0000000003c1';
const MEET = '00000000-0000-4000-8000-0000000003d1';
const UNKNOWN = '00000000-0000-4000-8000-0000000003ff';

describe('Phase 4 task create API and list filters', () => {
  let app: App;
  let repo: InMemoryTasks;
  let audit: InMemoryAuditLog;
  beforeEach(async () => {
    repo = new InMemoryTasks();
    repo.employees = new Set([EMP]);
    repo.projects = new Set([PROJ]);
    repo.meetings = new Set([MEET]);
    audit = new InMemoryAuditLog();
    app = await buildApp({ tasks: repo, audit } as Partial<ModuleDeps>);
  });
  afterEach(async () => app.close());

  const createOrg = async (c: Client, name: string) =>
    (await c.post('/orgs', { name })).json<{ organization: { id: string } }>().organization.id;
  async function join(owner: Client, orgId: string, email: string, role: 'viewer' | 'member') {
    const c = await signupAndLogin(app, email);
    expect((await owner.post(`/orgs/${orgId}/invitations`, { email, role })).statusCode).toBe(201);
    const sent = [...app.mail.sent].reverse().find((m) => m.template === 'invitation');
    const token = new URL(sent!.data.url!).searchParams.get('token')!;
    expect((await c.post('/invitations/accept', { token })).statusCode).toBe(200);
    expect((await c.post('/orgs/switch', { organizationId: orgId })).statusCode).toBe(200);
    return c;
  }

  it('members create tasks with defaults and full bodies; the result is a contract Task and audited', async () => {
    const owner = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(owner, 'Acme');
    const member = await join(owner, org, 'm@example.com', 'member');

    const min = await member.post(`/orgs/${org}/tasks`, { title: 'Write notes' });
    expect(min.statusCode).toBe(201);
    const t1 = min.json<Task>();
    expect(Value.Check(Task, t1)).toBe(true);
    expect(t1).toMatchObject({ organizationId: org, status: 'todo', priority: 'medium' });
    expect(t1.assigneeId).toBeUndefined();

    const full = await member.post(`/orgs/${org}/tasks`, {
      title: 'Ship',
      description: 'd',
      status: 'in_progress',
      priority: 'high',
      assigneeId: EMP,
      projectId: PROJ,
      meetingId: MEET,
      dueAt: '2026-11-01T00:00:00.000Z',
    });
    expect(full.statusCode).toBe(201);
    expect(full.json<Task>()).toMatchObject({
      status: 'in_progress',
      priority: 'high',
      assigneeId: EMP,
      projectId: PROJ,
      meetingId: MEET,
      dueAt: '2026-11-01T00:00:00.000Z',
    });
    expect(audit.events.filter((e) => e.action === 'task.create')).toHaveLength(2);
    expect((await member.get(`/orgs/${org}/tasks/${t1.id}`)).statusCode).toBe(200);
  });

  it('rejects viewers (403), bad bodies and foreign references (400), other orgs (404), no session (401)', async () => {
    const owner = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(owner, 'Acme');
    const viewer = await join(owner, org, 'v@example.com', 'viewer');
    expect((await viewer.post(`/orgs/${org}/tasks`, { title: 'x' })).statusCode).toBe(403);

    const bad = [
      {},
      { title: '' },
      { title: 'x', status: 'bogus' },
      { title: 'x', organizationId: org },
      { title: 'x', assigneeId: 'not-a-uuid' },
      { title: 'x', dueAt: 'tomorrow' },
      { title: 'x', assigneeId: null },
    ];
    for (const body of bad)
      expect((await owner.post(`/orgs/${org}/tasks`, body)).statusCode, JSON.stringify(body)).toBe(
        400,
      );
    for (const ref of ['assigneeId', 'projectId', 'meetingId'])
      expect(
        (await owner.post(`/orgs/${org}/tasks`, { title: 'x', [ref]: UNKNOWN })).statusCode,
      ).toBe(400);
    expect(repo.tasks).toHaveLength(0);

    const other = await signupAndLogin(app, 'x@example.com');
    await createOrg(other, 'Globex');
    expect((await other.post(`/orgs/${org}/tasks`, { title: 'pwn' })).statusCode).toBe(404);
    expect(
      (await app.inject({ method: 'POST', url: `/orgs/${org}/tasks`, payload: { title: 'x' } }))
        .statusCode,
    ).toBe(401);
    expect(repo.tasks).toHaveLength(0);
  });

  it('coerces unassigned=true from the query string and keeps tenants apart', async () => {
    const owner = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(owner, 'Acme');
    const a = (await owner.post(`/orgs/${org}/tasks`, { title: 'free' })).json<Task>();
    const b = (
      await owner.post(`/orgs/${org}/tasks`, { title: 'taken', assigneeId: EMP, status: 'done' })
    ).json<Task>();

    const un = await owner.get(`/orgs/${org}/tasks?unassigned=true`);
    expect(un.statusCode).toBe(200);
    expect(Value.Check(CursorPage(Task), un.json())).toBe(true);
    expect(un.json<{ items: Task[] }>().items.map((t) => t.id)).toEqual([a.id]);
    expect(
      (await owner.get(`/orgs/${org}/tasks?assigneeId=${EMP}`)).json<{ items: Task[] }>().items,
    ).toEqual([b]);
    expect(
      (await owner.get(`/orgs/${org}/tasks?status=todo&status=done&limit=1`)).json<{
        items: Task[];
        nextCursor: string | null;
      }>().nextCursor,
    ).not.toBeNull();
    expect((await owner.get(`/orgs/${org}/tasks?unassigned=false`)).statusCode).toBe(400);
    expect((await owner.get(`/orgs/${org}/tasks?bogus=1`)).statusCode).toBe(400);

    const other = await signupAndLogin(app, 'x@example.com');
    const orgX = await createOrg(other, 'X');
    await other.post(`/orgs/${orgX}/tasks`, { title: 'theirs' });
    expect(
      (await owner.get(`/orgs/${org}/tasks`)).json<{ items: Task[] }>().items.map((t) => t.title),
    ).toEqual(['free', 'taken']);
  });
});
