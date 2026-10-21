import { describe, it, expect, vi } from 'vitest';
import { GitHubIssuesProvider, parseIssueKey, IssueTrackerError, ApprovalRequiredError, type GitHubIssuesClient } from '../src';

const approved = { approved: true as const, approvedBy: 'user_1' };

const issue = (over: Record<string, unknown> = {}) => ({ id: 99, number: 7, title: 'T', state: 'open', html_url: 'https://github.com/o/r/issues/7', assignees: [{ login: 'bo' }], labels: [{ name: 'bug' }], ...over });

function mockClient() {
  const create = vi.fn().mockResolvedValue({ data: issue() });
  const get = vi.fn().mockResolvedValue({ data: issue() });
  const update = vi.fn().mockImplementation((p: { state?: string; state_reason?: string; labels?: string[] }) =>
    Promise.resolve({ data: issue({ state: p.state, state_reason: p.state_reason, labels: p.labels }) })
  );
  const repoGet = vi.fn().mockResolvedValue({ data: { full_name: 'o/r' } });
  const client = { rest: { issues: { create, get, update }, repos: { get: repoGet } } } as unknown as GitHubIssuesClient;
  return { client, create, get, update, repoGet };
}

describe('GitHubIssuesProvider', () => {
  it('creates issues in the default repo', async () => {
    const m = mockClient();
    const p = new GitHubIssuesProvider({ client: m.client, defaultRepo: 'o/r' });
    const res = await p.createIssue({ title: 'T', description: 'd', labels: ['bug'], externalRef: 'task_1' }, approved);
    expect(m.create).toHaveBeenCalledWith(expect.objectContaining({ owner: 'o', repo: 'r', title: 'T', labels: ['bug'] }));
    expect(res).toMatchObject({ provider: 'github', key: 'o/r#7', id: '99', status: 'open', assignees: ['bo'], labels: ['bug'] });
  });
  it('requires a repo', async () => {
    await expect(new GitHubIssuesProvider({ client: mockClient().client }).createIssue({ title: 'x' }, approved)).rejects.toBeInstanceOf(IssueTrackerError);
  });
  it('maps statuses to state/labels', async () => {
    const m = mockClient();
    const p = new GitHubIssuesProvider({ client: m.client, defaultRepo: 'o/r' });
    expect((await p.updateStatus('#7', 'in_progress', approved)).status).toBe('in_progress');
    expect((await p.updateStatus('o/r#7', 'done', approved)).status).toBe('done');
    expect((await p.updateStatus('7', 'closed', approved)).status).toBe('closed');
    expect(m.update).toHaveBeenCalledWith(expect.objectContaining({ issue_number: 7, state: 'closed', state_reason: 'completed' }));
  });
  it('getIssue returns null on 404 and wraps other errors', async () => {
    const m = mockClient();
    const p = new GitHubIssuesProvider({ client: m.client, defaultRepo: 'o/r' });
    m.get.mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status: 404 }));
    expect(await p.getIssue('#7')).toBeNull();
    m.get.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }));
    await expect(p.getIssue('#7')).rejects.toMatchObject({ name: 'IssueTrackerError', status: 500 });
  });
  it('healthCheck probes the repo', async () => {
    const m = mockClient();
    expect(await new GitHubIssuesProvider({ client: m.client, defaultRepo: 'o/r' }).healthCheck()).toEqual({ ok: true, provider: 'github' });
    m.repoGet.mockRejectedValueOnce(Object.assign(new Error('Bad credentials'), { status: 401 }));
    expect((await new GitHubIssuesProvider({ client: m.client, defaultRepo: 'o/r' }).healthCheck()).ok).toBe(false);
  });
  it('refuses writes without approval and makes no network call', async () => {
    const m = mockClient();
    const p = new GitHubIssuesProvider({ client: m.client, defaultRepo: 'o/r' });
    await expect(p.createIssue({ title: 'T' }, undefined as never)).rejects.toBeInstanceOf(ApprovalRequiredError);
    await expect(p.createIssue({ title: 'T' }, { approved: 'yes' })).rejects.toBeInstanceOf(ApprovalRequiredError);
    await expect(p.updateStatus('#7', 'done', { approved: false })).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(m.create).not.toHaveBeenCalled();
    expect(m.get).not.toHaveBeenCalled();
    expect(m.update).not.toHaveBeenCalled();
  });
  it('parses issue keys', () => {
    expect(parseIssueKey('a/b#3')).toEqual({ owner: 'a', repo: 'b', issue_number: 3 });
    expect(() => parseIssueKey('#3')).toThrow(/Invalid GitHub issue key/);
  });
});
