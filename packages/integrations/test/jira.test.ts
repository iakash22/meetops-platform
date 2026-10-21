import { describe, it, expect, vi } from 'vitest';
import { JiraIssueTrackerProvider, ApprovalRequiredError, toAdf, type FetchLike } from '../src';

const approved = { approved: true as const };
type Route = { status: number; body?: unknown };

function mockFetch(routes: Record<string, Route | Route[]>) {
  const fn = vi.fn(async (url: string, init?: { method?: string }) => {
    const key = `${init?.method ?? 'GET'} ${url.replace('https://acme.atlassian.net', '').split('?')[0]}`;
    const r = routes[key];
    const route = Array.isArray(r) ? r.shift() : r;
    if (!route) throw new Error(`unexpected ${key}`);
    const text = route.body === undefined ? '' : JSON.stringify(route.body);
    return { ok: route.status < 400, status: route.status, json: async () => JSON.parse(text), text: async () => text };
  });
  return fn;
}

const issueBody = (cat = 'new', name = 'To Do') => ({ id: '10001', key: 'MEET-1', fields: { summary: 'T', status: { name, statusCategory: { key: cat } }, assignee: { accountId: 'acc-1' }, labels: ['meetops'], updated: '2026-10-21T00:00:00.000+0000' } });
const make = (f: ReturnType<typeof mockFetch>, extra = {}) =>
  new JiraIssueTrackerProvider({ baseUrl: 'https://acme.atlassian.net', email: 'bot@acme.test', apiToken: 'tok', projectKey: 'MEET', fetch: f as unknown as FetchLike, ...extra });

describe('JiraIssueTrackerProvider', () => {
  it('validates base url and credentials', () => {
    expect(() => new JiraIssueTrackerProvider({ baseUrl: 'http://acme.atlassian.net', email: 'a', apiToken: 'b' })).toThrow(/Jira (base URL|email)/);
    expect(() => new JiraIssueTrackerProvider({ baseUrl: 'https://evil.example.com', email: 'a', apiToken: 'b' })).toThrow(/Jira (base URL|email)/);
    expect(() => new JiraIssueTrackerProvider({ baseUrl: 'https://acme.atlassian.net', email: '', apiToken: 'b' })).toThrow(/Jira (base URL|email)/);
  });
  it('creates issues with ADF description and basic auth', async () => {
    const f = mockFetch({ 'POST /rest/api/3/issue': { status: 201, body: { id: '10001', key: 'MEET-1' } }, 'GET /rest/api/3/issue/MEET-1': { status: 200, body: issueBody() } });
    const issue = await make(f).createIssue({ title: 'T', description: 'Hello\n\nWorld', labels: ['meet ops'], assignees: ['acc-1'], externalRef: 'task_1' }, approved);
    const [url, init] = f.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string }];
    expect(url).toBe('https://acme.atlassian.net/rest/api/3/issue');
    expect(init.headers.Authorization).toBe('Basic ' + Buffer.from('bot@acme.test:tok').toString('base64'));
    const sent = JSON.parse(init.body) as { fields: Record<string, unknown> };
    expect(sent.fields).toMatchObject({ project: { key: 'MEET' }, summary: 'T', issuetype: { name: 'Task' }, labels: ['meet-ops'], assignee: { accountId: 'acc-1' } });
    expect(sent.fields.description).toEqual(toAdf('Hello\n\nWorld\n\nMeetOps ref: task_1'));
    expect(issue).toMatchObject({ provider: 'jira', key: 'MEET-1', status: 'open', url: 'https://acme.atlassian.net/browse/MEET-1', assignees: ['acc-1'] });
  });
  it('getIssue maps status categories and returns null on 404', async () => {
    const f = mockFetch({ 'GET /rest/api/3/issue/MEET-1': [{ status: 200, body: issueBody('indeterminate', 'In Progress') }, { status: 200, body: issueBody('done', "Won't Do") }, { status: 404, body: { errorMessages: ['nope'] } }, { status: 500, body: { errorMessages: ['boom'] } }] });
    const p = make(f);
    expect((await p.getIssue('MEET-1'))?.status).toBe('in_progress');
    expect((await p.getIssue('MEET-1'))?.status).toBe('closed');
    expect(await p.getIssue('MEET-1')).toBeNull();
    await expect(p.getIssue('MEET-1')).rejects.toMatchObject({ status: 500, message: expect.stringContaining('boom') });
  });
  it('updateStatus looks up transition by configured name', async () => {
    const f = mockFetch({
      'GET /rest/api/3/issue/MEET-1/transitions': { status: 200, body: { transitions: [{ id: '11', name: 'Start work', to: { name: 'In Progress' } }, { id: '31', name: 'Finish', to: { name: 'Done' } }] } },
      'POST /rest/api/3/issue/MEET-1/transitions': { status: 204 },
      'GET /rest/api/3/issue/MEET-1': { status: 200, body: issueBody('done', 'Done') }
    });
    const issue = await make(f, { transitions: { done: 'Finish' } }).updateStatus('MEET-1', 'done', approved);
    expect(JSON.parse((f.mock.calls[1] as unknown as [string, { body: string }])[1].body)).toEqual({ transition: { id: '31' } });
    expect(issue.status).toBe('done');
  });
  it('updateStatus errors when transition is unavailable', async () => {
    const f = mockFetch({ 'GET /rest/api/3/issue/MEET-1/transitions': { status: 200, body: { transitions: [] } } });
    await expect(make(f).updateStatus('MEET-1', 'closed', approved)).rejects.toThrow(/No Jira transition/);
  });
  it('refuses writes without approval and makes no network call', async () => {
    const f = mockFetch({});
    const p = make(f);
    await expect(p.createIssue({ title: 'T' }, undefined as never)).rejects.toBeInstanceOf(ApprovalRequiredError);
    await expect(p.updateStatus('MEET-1', 'done', {})).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(f).not.toHaveBeenCalled();
  });
  it('healthCheck calls /myself', async () => {
    expect(await make(mockFetch({ 'GET /rest/api/3/myself': { status: 200, body: { accountId: 'x' } } })).healthCheck()).toEqual({ ok: true, provider: 'jira' });
    const bad = await make(mockFetch({ 'GET /rest/api/3/myself': { status: 401, body: {} } })).healthCheck();
    expect(bad).toMatchObject({ ok: false, message: expect.stringContaining('401') });
  });
});
