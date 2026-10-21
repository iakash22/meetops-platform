import { describe, it, expect, vi } from 'vitest';
import { JiraIssueTrackerProvider, ApprovalRequiredError, toAdf, type FetchLike, type CredentialResolver } from '../src';
import { governance, approvalFor, ORG, INTEGRATION } from './helpers';

type Route = { status: number; body?: unknown; headers?: Record<string, string> };

function mockFetch(routes: Record<string, Route | Route[]>) {
  return vi.fn(async (url: string, init?: { method?: string }) => {
    const key = `${init?.method ?? 'GET'} ${url.replace('https://acme.atlassian.net', '').split('?')[0]}`;
    const r = routes[key];
    const route = Array.isArray(r) ? r.shift() : r;
    if (!route) throw new Error(`unexpected ${key}`);
    const text = route.body === undefined ? '' : typeof route.body === 'string' ? route.body : JSON.stringify(route.body);
    return { ok: route.status >= 200 && route.status < 300, status: route.status, headers: new Headers(route.headers ?? {}), text: async () => text };
  });
}

const issueBody = (cat = 'new', name = 'To Do') => ({ id: '10001', key: 'MEET-1', fields: { summary: 'T', status: { name, statusCategory: { key: cat } }, assignee: { accountId: 'acc-1' }, labels: ['meetops'], updated: '2026-10-21T00:00:00.000+0000' } });

function make(f: ReturnType<typeof mockFetch>, extra: Record<string, unknown> = {}, verify = true) {
  const credentials: CredentialResolver & { resolve: ReturnType<typeof vi.fn> } = { resolve: vi.fn(async () => ({ kind: 'jira' as const, email: 'bot@acme.test', apiToken: 'tok' })) };
  const g = governance(verify);
  const provider = new JiraIssueTrackerProvider({ organizationId: ORG, integrationId: INTEGRATION, baseUrl: 'https://acme.atlassian.net', credentials, approvals: g.approvals, audit: g.audit, projectKey: 'MEET', fetch: f as unknown as FetchLike, retry: { maxAttempts: 1 }, ...extra });
  return { provider, credentials, g };
}

describe('JiraIssueTrackerProvider', () => {
  it('validates base url', () => {
    const f = mockFetch({});
    expect(() => make(f, { baseUrl: 'http://acme.atlassian.net' })).toThrow(/Jira base URL/);
    expect(() => make(f, { baseUrl: 'https://evil.example.com' })).toThrow(/Jira base URL/);
  });
  it('creates issues with ADF description, per-request basic auth, safe fetch options', async () => {
    const f = mockFetch({ 'POST /rest/api/3/issue': { status: 201, body: { id: '10001', key: 'MEET-1' } }, 'GET /rest/api/3/issue/MEET-1': { status: 200, body: issueBody() } });
    const { provider, credentials, g } = make(f);
    const input = { title: 'T', description: 'Hello\n\nWorld', labels: ['meet ops'], assignees: ['acc-1'], externalRef: 'task_1' };
    const issue = await provider.createIssue(input, approvalFor('jira', 'createIssue', input));
    const [url, init] = f.mock.calls[0] as unknown as [string, { headers: Record<string, string>; body: string; redirect: string; signal: AbortSignal }];
    expect(url).toBe('https://acme.atlassian.net/rest/api/3/issue');
    expect(init.headers.Authorization).toBe('Basic ' + Buffer.from('bot@acme.test:tok').toString('base64'));
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(credentials.resolve).toHaveBeenCalledTimes(2);
    const sent = JSON.parse(init.body) as { fields: Record<string, unknown> };
    expect(sent.fields).toMatchObject({ project: { key: 'MEET' }, summary: 'T', issuetype: { name: 'Task' }, labels: ['meet-ops'], assignee: { accountId: 'acc-1' } });
    expect(sent.fields.description).toEqual(toAdf('Hello\n\nWorld\n\nMeetOps ref: task_1'));
    expect(issue).toMatchObject({ provider: 'jira', key: 'MEET-1', status: 'open', url: 'https://acme.atlassian.net/browse/MEET-1' });
    expect(g.events.map((e) => e.phase)).toEqual(['attempt', 'success']);
  });
  it('supports OAuth bearer credentials', async () => {
    const f = mockFetch({ 'GET /rest/api/3/myself': { status: 200, body: {} } });
    const m = make(f);
    m.credentials.resolve.mockResolvedValueOnce({ kind: 'jira-oauth', accessToken: 'at' });
    await m.provider.healthCheck();
    expect((f.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1].headers.Authorization).toBe('Bearer at');
  });
  it('getIssue maps status categories, null on 404, sanitized errors', async () => {
    const f = mockFetch({ 'GET /rest/api/3/issue/MEET-1': [{ status: 200, body: issueBody('indeterminate', 'In Progress') }, { status: 200, body: issueBody('done', "Won't Do") }, { status: 404, body: { errorMessages: ['nope'] } }, { status: 500, body: { errorMessages: ['internal tok=abc'] } }] });
    const { provider } = make(f);
    expect((await provider.getIssue('MEET-1'))?.status).toBe('in_progress');
    expect((await provider.getIssue('MEET-1'))?.status).toBe('closed');
    expect(await provider.getIssue('MEET-1')).toBeNull();
    const err = await provider.getIssue('MEET-1').catch((e: Error) => e);
    expect(err).toMatchObject({ status: 500, message: 'Jira request failed (500)' });
  });
  it('rejects redirects, oversized and timed-out responses', async () => {
    const redirect = make(mockFetch({ 'GET /rest/api/3/myself': { status: 302, headers: { location: 'https://evil.test' } } }));
    expect(await redirect.provider.healthCheck()).toMatchObject({ ok: false, message: 'Jira request failed (302)' });
    const big = make(mockFetch({ 'GET /rest/api/3/issue/MEET-1': { status: 200, body: 'x'.repeat(2000) } }), { maxResponseBytes: 1000 });
    await expect(big.provider.getIssue('MEET-1')).rejects.toThrow(/too large/);
    const declared = make(mockFetch({ 'GET /rest/api/3/issue/MEET-1': { status: 200, body: '{}', headers: { 'content-length': '999999999' } } }));
    await expect(declared.provider.getIssue('MEET-1')).rejects.toThrow(/too large/);
    const hang = vi.fn((_u: string, init?: { signal?: AbortSignal }) => new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' })))));
    const slow = make(hang as never, { timeoutMs: 10 });
    await expect(slow.provider.getIssue('MEET-1')).rejects.toThrow(/timed out/);
  });
  it('updateStatus looks up transition by configured name', async () => {
    const f = mockFetch({
      'GET /rest/api/3/issue/MEET-1/transitions': { status: 200, body: { transitions: [{ id: '11', name: 'Start work', to: { name: 'In Progress' } }, { id: '31', name: 'Finish', to: { name: 'Done' } }] } },
      'POST /rest/api/3/issue/MEET-1/transitions': { status: 204 },
      'GET /rest/api/3/issue/MEET-1': { status: 200, body: issueBody('done', 'Done') }
    });
    const { provider } = make(f, { transitions: { done: 'Finish' } });
    const issue = await provider.updateStatus('MEET-1', 'done', approvalFor('jira', 'updateStatus', { key: 'MEET-1', status: 'done' }));
    expect(JSON.parse((f.mock.calls[1] as unknown as [string, { body: string }])[1].body)).toEqual({ transition: { id: '31' } });
    expect(issue.status).toBe('done');
  });
  it('updateStatus errors when transition is unavailable (audited failure)', async () => {
    const f = mockFetch({ 'GET /rest/api/3/issue/MEET-1/transitions': { status: 200, body: { transitions: [] } } });
    const { provider, g } = make(f);
    await expect(provider.updateStatus('MEET-1', 'closed', approvalFor('jira', 'updateStatus', { key: 'MEET-1', status: 'closed' }))).rejects.toThrow(/No Jira transition/);
    expect(g.events.map((e) => e.phase)).toEqual(['attempt', 'failure']);
  });
  it('refuses writes without verified approval and makes no network/credential call', async () => {
    const f = mockFetch({});
    const m = make(f);
    await expect(m.provider.createIssue({ title: 'T' }, undefined as never)).rejects.toBeInstanceOf(ApprovalRequiredError);
    await expect(m.provider.updateStatus('MEET-1', 'done', { approved: true })).rejects.toBeInstanceOf(ApprovalRequiredError);
    const r = make(f, {}, false);
    await expect(r.provider.createIssue({ title: 'T' }, approvalFor('jira', 'createIssue', { title: 'T' }))).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(f).not.toHaveBeenCalled();
    expect(m.credentials.resolve).not.toHaveBeenCalled();
    expect(r.credentials.resolve).not.toHaveBeenCalled();
  });
  it('retries 429 (Retry-After) and 5xx, never other 4xx', async () => {
    const sleep = vi.fn(async () => {});
    const f = mockFetch({ 'GET /rest/api/3/issue/MEET-1': [{ status: 429, headers: { 'retry-after': '3' } }, { status: 503 }, { status: 200, body: issueBody() }] });
    const { provider } = make(f, { retry: { sleep, random: () => 0 } });
    expect((await provider.getIssue('MEET-1'))?.key).toBe('MEET-1');
    expect(f).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls[0]).toEqual([3000]);
    const f400 = mockFetch({ 'GET /rest/api/3/issue/MEET-1': [{ status: 400 }, { status: 200, body: issueBody() }] });
    await expect(make(f400, { retry: { sleep } }).provider.getIssue('MEET-1')).rejects.toMatchObject({ status: 400 });
    expect(f400).toHaveBeenCalledTimes(1);
  });
  it('returns final sanitized error after exhausting retries; retries timeouts', async () => {
    const f = mockFetch({ 'GET /rest/api/3/issue/MEET-1': [{ status: 500 }, { status: 500 }] });
    await expect(make(f, { retry: { sleep: async () => {}, maxAttempts: 2 } }).provider.getIssue('MEET-1')).rejects.toMatchObject({ status: 500, message: 'Jira request failed (500)' });
    expect(f).toHaveBeenCalledTimes(2);
    let calls = 0;
    const flaky = vi.fn(async (_u: string, init?: { signal?: AbortSignal }) => {
      calls++;
      if (calls === 1) return new Promise((_r, rej) => init?.signal?.addEventListener('abort', () => rej(Object.assign(new Error('a'), { name: 'AbortError' }))));
      return { ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(issueBody()) };
    });
    expect((await make(flaky as never, { timeoutMs: 10, retry: { sleep: async () => {} } }).provider.getIssue('MEET-1'))?.key).toBe('MEET-1');
  });
  it('approval gate runs before any attempt even with retries', async () => {
    const f = mockFetch({});
    const sleep = vi.fn(async () => {});
    const { provider } = make(f, { retry: { sleep } });
    await expect(provider.updateStatus('MEET-1', 'done', undefined as never)).rejects.toBeInstanceOf(ApprovalRequiredError);
    expect(f).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });
  it('accepts the scoped-token API gateway base URL with site browse links', async () => {
    const gw = 'https://api.atlassian.com/ex/jira/11111111-2222-3333-4444-555555555555';
    const f = vi.fn(async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => JSON.stringify(issueBody()) }));
    const { provider } = make(f, { baseUrl: gw, siteUrl: 'https://acme.atlassian.net' });
    expect((await provider.getIssue('MEET-1'))?.url).toBe('https://acme.atlassian.net/browse/MEET-1');
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe(gw + '/rest/api/3/issue/MEET-1?fields=summary,status,assignee,labels,updated,resolution');
    expect(() => make(f as never, { baseUrl: 'https://api.atlassian.com/other' })).toThrow(/Jira base URL/);
  });
  it('healthCheck calls /myself', async () => {
    expect(await make(mockFetch({ 'GET /rest/api/3/myself': { status: 200, body: { accountId: 'x' } } })).provider.healthCheck()).toEqual({ ok: true, provider: 'jira' });
    expect(await make(mockFetch({ 'GET /rest/api/3/myself': { status: 401, body: {} } })).provider.healthCheck()).toMatchObject({ ok: false, message: 'Jira request failed (401)' });
  });
});
