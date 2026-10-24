import { describe, it, expect, vi } from 'vitest';
import { GitHubIssuesProvider, parseIssueKey, ApprovalRequiredError, ApprovalMismatchError, type GitHubIssuesClient, type CredentialResolver } from '../src';
import { governance, approvalFor, ORG, INTEGRATION } from './helpers';

const issue = (over: Record<string, unknown> = {}) => ({ id: 99, number: 7, title: 'T', state: 'open', html_url: 'https://github.com/o/r/issues/7', assignees: [{ login: 'bo' }], labels: [{ name: 'bug' }], ...over });

function setup(opts: { verify?: boolean; defaultRepo?: string; retry?: Record<string, unknown> } = {}) {
  const create = vi.fn().mockResolvedValue({ data: issue() });
  const get = vi.fn().mockResolvedValue({ data: issue() });
  const update = vi.fn().mockImplementation((p: { state?: string; state_reason?: string; labels?: string[] }) =>
    Promise.resolve({ data: issue({ state: p.state, state_reason: p.state_reason, labels: p.labels }) })
  );
  const repoGet = vi.fn().mockResolvedValue({ data: { full_name: 'o/r' } });
  const client = { rest: { issues: { create, get, update }, repos: { get: repoGet } } } as unknown as GitHubIssuesClient;
  const clientFactory = vi.fn(() => client);
  const credentials: CredentialResolver & { resolve: ReturnType<typeof vi.fn> } = { resolve: vi.fn(async () => ({ kind: 'github' as const, token: 'ghs_test' })) };
  const g = governance(opts.verify ?? true);
  const provider = new GitHubIssuesProvider({
    organizationId: ORG,
    integrationId: INTEGRATION,
    credentials,
    approvals: g.approvals,
    audit: g.audit,
    clientFactory,
    retry: opts.retry ?? { maxAttempts: 1 },
    ...(opts.defaultRepo === undefined ? { defaultRepo: 'o/r' } : opts.defaultRepo ? { defaultRepo: opts.defaultRepo } : {})
  });
  return { provider, create, get, update, repoGet, clientFactory, credentials, g };
}

describe('GitHubIssuesProvider', () => {
  it('creates issues with a verified approval; credentials resolved per call', async () => {
    const s = setup();
    const input = { title: 'T', description: 'd', labels: ['bug'], externalRef: 'task_1' };
    const res = await s.provider.createIssue(input, approvalFor('github', 'createIssue', input));
    expect(s.credentials.resolve).toHaveBeenCalledWith(ORG, INTEGRATION);
    expect(s.clientFactory).toHaveBeenCalledWith('ghs_test');
    expect(s.create).toHaveBeenCalledWith(expect.objectContaining({ owner: 'o', repo: 'r', title: 'T', labels: ['bug'] }));
    expect(res).toMatchObject({ provider: 'github', key: 'o/r#7', id: '99', status: 'open', assignees: ['bo'] });
    expect(s.g.events.map((e) => e.phase)).toEqual(['attempt', 'success']);
  });
  it('maps statuses to state/labels', async () => {
    const s = setup();
    const up = (key: string, status: 'in_progress' | 'done' | 'closed') => s.provider.updateStatus(key, status, approvalFor('github', 'updateStatus', { key, status }));
    expect((await up('#7', 'in_progress')).status).toBe('in_progress');
    expect((await up('o/r#7', 'done')).status).toBe('done');
    expect((await up('7', 'closed')).status).toBe('closed');
    expect(s.update).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 7, state: 'closed', state_reason: 'completed' }));
  });
  it('refuses writes without a matching approval and makes no network or credential call', async () => {
    const s = setup();
    await expect(s.provider.createIssue({ title: 'T' }, undefined as never)).rejects.toBeInstanceOf(ApprovalRequiredError);
    await expect(s.provider.createIssue({ title: 'T' }, { approved: true })).rejects.toBeInstanceOf(ApprovalRequiredError);
    await expect(s.provider.createIssue({ title: 'T2' }, approvalFor('github', 'createIssue', { title: 'T' }))).rejects.toBeInstanceOf(ApprovalMismatchError);
    await expect(s.provider.updateStatus('#7', 'done', approvalFor('github', 'updateStatus', { key: '#7', status: 'closed' }))).rejects.toBeInstanceOf(ApprovalMismatchError);
    const rejected = setup({ verify: false });
    await expect(rejected.provider.updateStatus('#7', 'done', approvalFor('github', 'updateStatus', { key: '#7', status: 'done' }))).rejects.toBeInstanceOf(ApprovalRequiredError);
    for (const x of [s, rejected]) {
      expect(x.create).not.toHaveBeenCalled();
      expect(x.update).not.toHaveBeenCalled();
      expect(x.credentials.resolve).not.toHaveBeenCalled();
    }
  });
  it('requires a repo', async () => {
    const s = setup({ defaultRepo: '' });
    await expect(s.provider.createIssue({ title: 'x' }, approvalFor('github', 'createIssue', { title: 'x' }))).rejects.toThrow(/No repository/);
    expect(s.g.events.map((e) => e.phase)).toEqual(['attempt', 'failure']);
  });
  it('getIssue returns null on 404 and sanitizes other errors', async () => {
    const s = setup();
    s.get.mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }));
    expect(await s.provider.getIssue('#7')).toBeNull();
    s.get.mockRejectedValueOnce(Object.assign(new Error('Bad credentials ghs_test body'), { status: 500 }));
    const err = await s.provider.getIssue('#7').catch((e: Error) => e);
    expect(err).toMatchObject({ name: 'IssueTrackerError', status: 500, message: 'GitHub request failed (500)' });
  });
  it('fails when credentials are unavailable', async () => {
    const s = setup();
    s.credentials.resolve.mockResolvedValueOnce({ kind: 'jira', email: 'x', apiToken: 'y' });
    await expect(s.provider.getIssue('#7')).rejects.toThrow(/credentials unavailable/);
  });
  it('healthCheck probes the repo', async () => {
    const s = setup();
    expect(await s.provider.healthCheck()).toEqual({ ok: true, provider: 'github' });
    s.repoGet.mockRejectedValueOnce(Object.assign(new Error('Bad credentials'), { status: 401 }));
    expect(await s.provider.healthCheck()).toMatchObject({ ok: false, message: 'GitHub request failed (401)' });
  });
  it('retries rate-limited calls (secondary 403 + Retry-After) and never retries 422', async () => {
    const sleep = vi.fn(async () => {});
    const s = setup({ retry: { sleep, random: () => 0 } });
    s.create.mockRejectedValueOnce(Object.assign(new Error('rate'), { status: 403, response: { headers: { 'retry-after': '2' } } }));
    const input = { title: 'T' };
    expect((await s.provider.createIssue(input, approvalFor('github', 'createIssue', input))).key).toBe('o/r#7');
    expect(s.create).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
    s.create.mockRejectedValueOnce(Object.assign(new Error('invalid'), { status: 422 }));
    await expect(s.provider.createIssue(input, approvalFor('github', 'createIssue', input))).rejects.toMatchObject({ status: 422 });
    expect(s.create).toHaveBeenCalledTimes(3);
  });
  it('does not retry issues.create on 5xx or network errors; still retries update', async () => {
    const sleep = vi.fn(async () => {});
    const s = setup({ retry: { sleep, random: () => 0 } });
    const input = { title: 'T' };
    s.create.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 502 }));
    await expect(s.provider.createIssue(input, approvalFor('github', 'createIssue', input))).rejects.toMatchObject({ status: 502 });
    s.create.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(s.provider.createIssue(input, approvalFor('github', 'createIssue', input))).rejects.toMatchObject({ message: 'GitHub request failed' });
    expect(s.create).toHaveBeenCalledTimes(2);
    expect(sleep).not.toHaveBeenCalled();
  });
  it('waits for x-ratelimit-reset on exhausted primary limit', async () => {
    const sleep = vi.fn(async () => {});
    const now = 1_800_000_000_000;
    const s = setup({ retry: { sleep, now: () => now, random: () => 0 } });
    s.get.mockRejectedValueOnce(Object.assign(new Error('rl'), { status: 403, response: { headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 5) } } }));
    expect((await s.provider.getIssue('#7'))?.key).toBe('o/r#7');
    expect(sleep).toHaveBeenCalledWith(5000);
  });
  it('approval gate runs before any retry attempt', async () => {
    const sleep = vi.fn(async () => {});
    const s = setup({ retry: { sleep } });
    await expect(s.provider.createIssue({ title: 'T' }, undefined as never)).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(s.create).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });
  it('parses issue keys', () => {
    expect(parseIssueKey('a/b#3')).toEqual({ owner: 'a', repo: 'b', issue_number: 3 });
    expect(() => parseIssueKey('#3')).toThrow(/Invalid GitHub issue key/);
  });
});
