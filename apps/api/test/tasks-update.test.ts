import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { Task } from '@meetops/contracts';
import { InMemoryTasks } from '../src/modules/tasks/in-memory.repository.js';
import { InMemoryAuditLog } from '../src/modules/auth/domain/audit.js';
import type { ModuleDeps } from '../src/modules/index.js';
import { buildApp, signupAndLogin, type App, type Client } from './helpers.js';

const T1 = '00000000-0000-4000-8000-0000000002a1';
const EMP = '00000000-0000-4000-8000-0000000002b1';
const OTHER_EMP = '00000000-0000-4000-8000-0000000002b2';
const MISSING = '00000000-0000-4000-8000-0000000002ff';

describe('Phase 4 task get and update API', () => {
  let app: App;
  let repo: InMemoryTasks;
  let audit: InMemoryAuditLog;
  beforeEach(async () => {
    repo = new InMemoryTasks();
    repo.employees = new Set([EMP]);
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
  const seed = (organizationId: string) =>
    repo.tasks.push({
      id: T1,
      organizationId,
      title: 'Ship',
      description: 'd',
      status: 'todo',
      priority: 'medium',
      dueAt: '2026-11-01T00:00:00.000Z',
      createdAt: '2026-10-27T00:00:00.000Z',
      updatedAt: '2026-10-27T00:00:00.000Z',
    });
  const path = (o: string, t = T1) => `/orgs/${o}/tasks/${t}`;

  it('gets a task and lets members patch it, with null clearing fields', async () => {
    const owner = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(owner, 'Acme');
    seed(org);
    const member = await join(owner, org, 'm@example.com', 'member');
    const got = await member.get(path(org));
    expect(got.statusCode).toBe(200);
    expect(Value.Check(Task, got.json())).toBe(true);

    const r = await member.patch(path(org), {
      status: 'in_progress',
      assigneeId: EMP,
      description: null,
      dueAt: null,
    });
    expect(r.statusCode).toBe(200);
    const t = r.json<Task>();
    expect(Value.Check(Task, t)).toBe(true);
    expect(t).toMatchObject({ status: 'in_progress', assigneeId: EMP, title: 'Ship' });
    expect(t.description).toBeUndefined();
    expect(t.dueAt).toBeUndefined();
    expect(audit.events.some((e) => e.action === 'task.update' && e.targetId === T1)).toBe(true);

    expect(
      (await member.patch(path(org), { assigneeId: null })).json<Task>().assigneeId,
    ).toBeUndefined();
  });

  it('rejects viewers, empty or unknown bodies, bad assignees, and hides other orgs', async () => {
    const owner = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(owner, 'Acme');
    seed(org);
    const viewer = await join(owner, org, 'v@example.com', 'viewer');
    expect((await viewer.get(path(org))).statusCode).toBe(200);
    expect((await viewer.patch(path(org), { title: 'x' })).statusCode).toBe(403);
    expect((await owner.patch(path(org), {})).statusCode).toBe(400);
    expect((await owner.patch(path(org), { organizationId: org })).statusCode).toBe(400);
    expect((await owner.patch(path(org), { status: 'bogus' })).statusCode).toBe(400);
    expect((await owner.patch(path(org), { assigneeId: OTHER_EMP })).statusCode).toBe(400);
    expect((await owner.get(path(org, MISSING))).statusCode).toBe(404);
    expect((await owner.patch(path(org, MISSING), { title: 'x' })).statusCode).toBe(404);

    const other = await signupAndLogin(app, 'x@example.com');
    const orgX = await createOrg(other, 'X');
    expect((await other.get(path(orgX))).statusCode).toBe(404);
    expect((await other.patch(path(orgX), { title: 'pwn' })).statusCode).toBe(404);
    expect(repo.tasks[0]!.title).toBe('Ship');
    expect((await app.inject({ method: 'GET', url: path(org) })).statusCode).toBe(401);
  });
});
