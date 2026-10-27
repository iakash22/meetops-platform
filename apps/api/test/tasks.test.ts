import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { CursorPage, ExtractedTask, Task } from '@meetops/contracts';
import { InMemoryTasks } from '../src/modules/tasks/in-memory.repository.js';
import { selectTaskRepositories } from '../src/modules/tasks/index.js';
import { InMemoryAuditLog } from '../src/modules/auth/domain/audit.js';
import { MissingProductionDependencyError, type ModuleDeps } from '../src/modules/index.js';
import { buildApp, signupAndLogin, type App, type Client } from './helpers.js';

const MEET = '00000000-0000-4000-8000-0000000000a1';
const ET1 = '00000000-0000-4000-8000-0000000000e1';
const ET2 = '00000000-0000-4000-8000-0000000000e2';
const MISSING = '00000000-0000-4000-8000-0000000000ff';

describe('Phase 4 task and extracted-task review API', () => {
  let app: App;
  let repo: InMemoryTasks;
  let audit: InMemoryAuditLog;
  beforeEach(async () => {
    repo = new InMemoryTasks();
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
  const extracted = (id: string, createdAt: string): ExtractedTask => ({
    id,
    meetingId: MEET,
    reportId: '00000000-0000-4000-8000-0000000000c1',
    title: 'Ship it',
    assigneeHint: 'Bob',
    confidence: 0.8,
    sourceSegmentIds: [],
    createdAt,
  });

  it('lists pending extracted tasks with a cursor, accepts one into a Task and dismisses another', async () => {
    const owner = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(owner, 'Acme');
    repo.addExtracted(org, extracted(ET1, '2026-10-26T00:00:00.000Z'));
    repo.addExtracted(org, extracted(ET2, '2026-10-26T00:00:01.000Z'));

    const p1 = await owner.get(`/orgs/${org}/extracted-tasks?meetingId=${MEET}&limit=1`);
    expect(p1.statusCode).toBe(200);
    const body = p1.json<{ items: ExtractedTask[]; nextCursor: string }>();
    expect(Value.Check(CursorPage(ExtractedTask), body)).toBe(true);
    expect(body.items.map((i) => i.id)).toEqual([ET1]);
    const p2 = await owner.get(`/orgs/${org}/extracted-tasks?cursor=${body.nextCursor}`);
    expect(p2.json<{ items: ExtractedTask[] }>().items.map((i) => i.id)).toEqual([ET2]);

    const acc = await owner.post(`/orgs/${org}/extracted-tasks/${ET1}/accept`, {
      title: 'Ship v2',
      priority: 'high',
      dueAt: '2026-11-01T00:00:00.000Z',
    });
    expect(acc.statusCode).toBe(201);
    const task = acc.json<Task>();
    expect(Value.Check(Task, task)).toBe(true);
    expect(task).toMatchObject({
      extractedTaskId: ET1,
      meetingId: MEET,
      title: 'Ship v2',
      status: 'todo',
      organizationId: org,
    });
    expect(
      (
        await owner.post(`/orgs/${org}/extracted-tasks/${ET1}/accept`, {
          title: 'x',
          priority: 'low',
        })
      ).statusCode,
    ).toBe(409);
    expect((await owner.post(`/orgs/${org}/extracted-tasks/${ET2}/dismiss`)).statusCode).toBe(204);
    expect((await owner.post(`/orgs/${org}/extracted-tasks/${ET2}/dismiss`)).statusCode).toBe(409);
    expect((await owner.post(`/orgs/${org}/extracted-tasks/${MISSING}/dismiss`)).statusCode).toBe(
      404,
    );
    expect(repo.approvals.map((a) => a.decision)).toEqual(['approved', 'rejected']);
    expect(audit.events.map((e) => e.action)).toEqual(
      expect.arrayContaining(['extracted_task.accept', 'extracted_task.dismiss']),
    );

    expect(
      (await owner.get(`/orgs/${org}/extracted-tasks`)).json<{ items: unknown[] }>().items,
    ).toEqual([]);
    const tasks = await owner.get(`/orgs/${org}/tasks?status=todo&priority=high`);
    expect(tasks.statusCode).toBe(200);
    expect(tasks.json<{ items: Task[] }>().items.map((t) => t.id)).toEqual([task.id]);
    expect(
      (await owner.get(`/orgs/${org}/tasks?assigneeId=${MISSING}&unassigned=true`)).statusCode,
    ).toBe(400);
  });

  it('viewers read but cannot review (403); other orgs get 404; no session 401', async () => {
    const owner = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(owner, 'Acme');
    repo.addExtracted(org, extracted(ET1, '2026-10-26T00:00:00.000Z'));
    const viewer = await join(owner, org, 'viewer@example.com', 'viewer');
    expect((await viewer.get(`/orgs/${org}/extracted-tasks`)).statusCode).toBe(200);
    expect(
      (
        await viewer.post(`/orgs/${org}/extracted-tasks/${ET1}/accept`, {
          title: 't',
          priority: 'low',
        })
      ).statusCode,
    ).toBe(403);
    const member = await join(owner, org, 'member@example.com', 'member');
    expect((await member.post(`/orgs/${org}/extracted-tasks/${ET1}/dismiss`)).statusCode).toBe(204);

    const other = await signupAndLogin(app, 'other@example.com');
    await createOrg(other, 'Globex');
    expect((await other.get(`/orgs/${org}/extracted-tasks`)).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/orgs/${org}/tasks` })).statusCode).toBe(401);
    expect((await owner.get(`/orgs/${org}/extracted-tasks?cursor=bogus`)).statusCode).toBe(400);
  });

  it('refuses in-memory storage outside development/test', () => {
    expect(() => selectTaskRepositories({} as never, 'production')).toThrow(
      MissingProductionDependencyError,
    );
  });
});
