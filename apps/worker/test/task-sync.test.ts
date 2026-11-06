import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { GitHubIssuesClient } from '@meetops/integrations';
import type { TaskSyncJobRecord } from '@meetops/database';
import {
  TaskSyncRetryableError,
  processTaskSyncJob,
  type TaskSyncConnection,
  type TaskSyncDeps,
  type TaskSyncJobStore,
} from '../src/integrations/task-sync.js';

/** Org-scoped in-memory twin of createTaskSyncRepository (same conditional transitions). */
class MemJobs implements TaskSyncJobStore {
  rows = new Map<string, TaskSyncJobRecord>();
  links: {
    organizationId: string;
    taskId: string;
    integrationId: string;
    externalId: string;
    externalUrl: string | null;
  }[] = [];
  private find(org: string, id: string) {
    const r = this.rows.get(id);
    return r && r.organizationId === org ? r : undefined;
  }
  async get(org: string, id: string) {
    const r = this.find(org, id);
    return r ? { ...r } : null;
  }
  async begin(org: string, id: string) {
    await Promise.resolve();
    const r = this.find(org, id);
    if (!r || r.status !== 'queued') return false;
    r.status = 'creating';
    r.attempts++;
    return true;
  }
  async succeed(org: string, id: string, i: { externalId: string; externalUrl?: string | null }) {
    const r = this.find(org, id);
    if (!r || r.status !== 'creating') return false;
    Object.assign(r, {
      status: 'succeeded',
      externalId: i.externalId,
      externalUrl: i.externalUrl ?? null,
    });
    this.links.push({
      organizationId: org,
      taskId: r.taskId,
      integrationId: r.integrationId,
      externalId: i.externalId,
      externalUrl: i.externalUrl ?? null,
    });
    return true;
  }
  async finish(
    org: string,
    id: string,
    status: 'queued' | 'failed' | 'needs_reconcile',
    code: string,
  ) {
    const r = this.find(org, id);
    if (!r || r.status !== 'creating') return false;
    Object.assign(r, { status, errorCode: code });
    return true;
  }
  async reject(org: string, id: string, code: string) {
    const r = this.find(org, id);
    if (!r || r.status !== 'queued') return false;
    Object.assign(r, { status: 'failed', errorCode: code });
    return true;
  }
}

const ORG = randomUUID();
const OTHER = randomUUID();
const log = { info: () => undefined, warn: () => undefined };

function setup() {
  const jobs = new MemJobs();
  const integrationId = randomUUID();
  const taskId = randomUUID();
  const extractedTaskId = randomUUID();
  const approvalId = randomUUID();
  const syncId = randomUUID();
  const now = new Date();
  jobs.rows.set(syncId, {
    id: syncId,
    organizationId: ORG,
    taskId,
    integrationId,
    approvalId,
    provider: 'github',
    target: 'acme/app',
    status: 'queued',
    attempts: 0,
    externalId: null,
    externalUrl: null,
    errorCode: null,
    createdAt: now,
    updatedAt: now,
  });
  const conn: TaskSyncConnection = {
    id: integrationId,
    organizationId: ORG,
    provider: 'github',
    status: 'active',
    externalAccountId: '99',
    displayName: 'acme',
  };
  const approval = {
    id: approvalId,
    extractedTaskId,
    reviewerId: randomUUID(),
    decision: 'approved',
  };
  const creates: unknown[] = [];
  let createImpl: () => Promise<{ data: Record<string, unknown> }> = async () => ({
    data: {
      id: 1,
      number: 5,
      title: 'Ship it',
      state: 'open',
      html_url: 'https://github.com/acme/app/issues/5',
      labels: [],
    },
  });
  const client = {
    rest: {
      issues: {
        create: async (p: unknown) => {
          creates.push(p);
          return createImpl();
        },
      },
    },
  } as unknown as GitHubIssuesClient;
  let credsFail = false;
  const auditEvents: string[] = [];
  let auditFailOn: string | undefined;
  const deps: TaskSyncDeps = {
    jobs,
    lookups: {
      connection: async (org, id) => (org === ORG && id === integrationId ? { ...conn } : null),
      task: async (org, id) =>
        org === ORG && id === taskId
          ? { id: taskId, title: 'Ship it', description: 'desc', extractedTaskId }
          : null,
      approval: async (org, id) => (org === ORG && id === approvalId ? { ...approval } : null),
      hasIssueLink: async (org, t, i) =>
        jobs.links.some((l) => l.organizationId === org && l.taskId === t && l.integrationId === i),
    },
    credentials: async () => {
      if (credsFail) throw new Error('token unavailable');
      return { kind: 'github', token: 'ghs_test' };
    },
    audit: async (e) => {
      if (e.phase === auditFailOn) throw new Error('audit down');
      auditEvents.push(e.phase);
    },
    log,
    githubClientFactory: () => client,
  };
  return {
    jobs,
    deps,
    creates,
    approval,
    conn,
    auditEvents,
    syncId,
    taskId,
    integrationId,
    payload: { jobVersion: 1 as const, organizationId: ORG, syncId },
    setCreate: (f: typeof createImpl) => (createImpl = f),
    setCredsFail: (v: boolean) => (credsFail = v),
    setAuditFailOn: (p: string) => (auditFailOn = p),
  };
}

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

describe('processTaskSyncJob (GitHub adapter, mocked client)', () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => (s = setup()));

  it('creates the issue once and stores the external id and URL on the task', async () => {
    expect(await processTaskSyncJob(s.deps, s.payload)).toBe('succeeded');
    expect(s.creates).toHaveLength(1);
    expect(s.creates[0]).toMatchObject({ owner: 'acme', repo: 'app', title: 'Ship it' });
    expect(s.jobs.rows.get(s.syncId)).toMatchObject({
      status: 'succeeded',
      attempts: 1,
      externalId: 'acme/app#5',
      externalUrl: 'https://github.com/acme/app/issues/5',
    });
    expect(s.jobs.links).toEqual([
      expect.objectContaining({
        taskId: s.taskId,
        externalId: 'acme/app#5',
        externalUrl: 'https://github.com/acme/app/issues/5',
      }),
    ]);
    expect(s.auditEvents).toEqual(['attempt', 'success']);
  });

  it('redelivery and concurrent duplicates never create a second issue', async () => {
    const [a, b] = await Promise.all([
      processTaskSyncJob(s.deps, s.payload),
      processTaskSyncJob(s.deps, s.payload),
    ]);
    expect([a, b].sort()).toEqual(['skipped', 'succeeded']);
    expect(await processTaskSyncJob(s.deps, s.payload)).toBe('skipped');
    expect(s.creates).toHaveLength(1);
    expect(s.jobs.links).toHaveLength(1);
  });

  it('a 5xx after sending is ambiguous: needs_reconcile, never re-sent', async () => {
    s.setCreate(async () => Promise.reject(httpError(502)));
    expect(await processTaskSyncJob(s.deps, s.payload)).toBe('needs_reconcile');
    expect(s.jobs.rows.get(s.syncId)).toMatchObject({
      status: 'needs_reconcile',
      errorCode: 'AMBIGUOUS_PROVIDER_ERROR',
    });
    expect(await processTaskSyncJob(s.deps, s.payload)).toBe('skipped');
    expect(s.creates).toHaveLength(1);
  });

  it('a 4xx is a definite rejection: failed, no retry', async () => {
    s.setCreate(async () => Promise.reject(httpError(422)));
    expect(await processTaskSyncJob(s.deps, s.payload)).toBe('failed');
    expect(s.jobs.rows.get(s.syncId)).toMatchObject({
      status: 'failed',
      errorCode: 'PROVIDER_REJECTED_422',
    });
    expect(s.jobs.links).toHaveLength(0);
  });

  it('not sent (credentials unavailable): back to queued, throws for a BullMQ retry, then succeeds once', async () => {
    s.setCredsFail(true);
    await expect(processTaskSyncJob(s.deps, s.payload)).rejects.toBeInstanceOf(
      TaskSyncRetryableError,
    );
    expect(s.jobs.rows.get(s.syncId)).toMatchObject({ status: 'queued', errorCode: 'NOT_SENT' });
    expect(s.creates).toHaveLength(0);
    s.setCredsFail(false);
    expect(await processTaskSyncJob(s.deps, s.payload)).toBe('succeeded');
    expect(s.creates).toHaveLength(1);
    expect(s.jobs.rows.get(s.syncId)!.attempts).toBe(2);
  });

  it('a row left in creating (crash mid-create) is never re-sent', async () => {
    s.jobs.rows.get(s.syncId)!.status = 'creating';
    expect(await processTaskSyncJob(s.deps, s.payload)).toBe('needs_reconcile');
    expect(s.jobs.rows.get(s.syncId)).toMatchObject({ errorCode: 'INTERRUPTED' });
    expect(s.creates).toHaveLength(0);
  });

  it('refuses an approval revoked while queued, and an inactive integration (no fallback)', async () => {
    s.approval.decision = 'rejected';
    expect(await processTaskSyncJob(s.deps, s.payload)).toBe('failed');
    expect(s.jobs.rows.get(s.syncId)).toMatchObject({
      status: 'failed',
      errorCode: 'APPROVAL_REQUIRED',
    });
    const t = setup();
    t.conn.status = 'error';
    t.deps.lookups.connection = async () => ({ ...t.conn });
    expect(await processTaskSyncJob(t.deps, t.payload)).toBe('failed');
    expect(t.jobs.rows.get(t.syncId)).toMatchObject({ errorCode: 'INTEGRATION_NOT_CONNECTED' });
    expect(s.creates).toHaveLength(0);
    expect(t.creates).toHaveLength(0);
  });

  it('gates on a single approval read: the checked approval is the one written', async () => {
    let reads = 0;
    const base = s.deps.lookups.approval.bind(s.deps.lookups);
    // First read sees a rejected approval, later reads an approved one: the gate must use the first.
    s.deps.lookups.approval = async (org, id) => {
      reads += 1;
      const a = await base(org, id);
      return a && reads === 1 ? { ...a, decision: 'rejected' } : a;
    };
    expect(await processTaskSyncJob(s.deps, s.payload)).toBe('failed');
    expect(s.jobs.rows.get(s.syncId)).toMatchObject({ errorCode: 'APPROVAL_REQUIRED' });
    expect(reads).toBe(1);
    expect(s.creates).toHaveLength(0);

    const t = setup();
    let okReads = 0;
    const tBase = t.deps.lookups.approval.bind(t.deps.lookups);
    t.deps.lookups.approval = async (org, id) => {
      okReads += 1;
      return tBase(org, id);
    };
    expect(await processTaskSyncJob(t.deps, t.payload)).toBe('succeeded');
    // One read at the gate plus one fresh read by the write-time verifier.
    expect(okReads).toBe(2);
  });

  it('write-time recheck aborts when the approval id or reviewer differs from the gate read', async () => {
    for (const change of [{ reviewerId: 'other-reviewer' }, { id: 'other-approval-id' }]) {
      const t = setup();
      let reads = 0;
      const base = t.deps.lookups.approval.bind(t.deps.lookups);
      // Gate read sees the original approval; the write-time read sees a swapped one (still approved).
      t.deps.lookups.approval = async (org, id) => {
        reads += 1;
        const a = await base(org, id);
        return a && reads > 1 ? { ...a, ...change } : a;
      };
      expect(await processTaskSyncJob(t.deps, t.payload)).toBe('failed');
      expect(t.jobs.rows.get(t.syncId)).toMatchObject({ errorCode: 'APPROVAL_REQUIRED' });
      expect(reads).toBe(2);
      expect(t.creates).toHaveLength(0);
    }
  });

  it('cross-org: a job naming another org cannot touch this org row', async () => {
    expect(await processTaskSyncJob(s.deps, { ...s.payload, organizationId: OTHER })).toBe(
      'skipped',
    );
    expect(s.jobs.rows.get(s.syncId)!.status).toBe('queued');
    expect(s.creates).toHaveLength(0);
  });

  it('created upstream but the success audit failed: still recorded, not re-sent', async () => {
    s.setAuditFailOn('success');
    expect(await processTaskSyncJob(s.deps, s.payload)).toBe('succeeded');
    expect(s.creates).toHaveLength(1);
    expect(s.jobs.rows.get(s.syncId)!.externalId).toBe('acme/app#5');
  });
});
