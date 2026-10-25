import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, CSRF_HEADER, createApiClient } from '@/lib/api/client';
import { fetchAllPages } from '@/lib/api/fetch-all';
import { invitation, memberList, sessionList } from './fixtures/data';

const json = (body: unknown, status = 200) =>
  new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
type Call = [string, RequestInit];
const ORG = '00000000-0000-4000-8000-000000000001';
const USER = '10000000-0000-4000-8000-000000000003';

function client(...responses: Response[]) {
  const fetchMock = vi.fn();
  for (const r of responses) fetchMock.mockResolvedValueOnce(r);
  const api = createApiClient({
    baseUrl: 'http://api',
    fetch: fetchMock,
    getCsrfToken: () => 'csrf-1',
  });
  const calls = () => fetchMock.mock.calls as Call[];
  return { api, calls };
}

describe('sessions endpoints', () => {
  it('GET /auth/sessions with cursor params', async () => {
    const { api, calls } = client(json(sessionList));
    await expect(api.auth.sessions({ limit: 100, cursor: 'c 1' })).resolves.toEqual(sessionList);
    expect(calls()[0]![0]).toBe('http://api/auth/sessions?cursor=c+1&limit=100');
    expect(calls()[0]![1].method).toBe('GET');
  });

  it('DELETE /auth/sessions/:id sends CSRF and resolves on 204', async () => {
    const { api, calls } = client(new Response(null, { status: 204 }));
    await expect(api.auth.revokeSession('s/1')).resolves.toBeUndefined();
    const [url, init] = calls()[0]!;
    expect(url).toBe('http://api/auth/sessions/s%2F1');
    expect(init.method).toBe('DELETE');
    expect((init.headers as Record<string, string>)[CSRF_HEADER]).toBe('csrf-1');
  });

  it('a 404 revoke is an ApiError NOT_FOUND', async () => {
    const { api } = client(json({ error: { code: 'NOT_FOUND', message: 'x' } }, 404));
    await expect(api.auth.revokeSession('s1')).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
  });
});

describe('members and invitations endpoints', () => {
  it('lists members', async () => {
    const { api, calls } = client(json(memberList));
    await expect(api.members.list(ORG)).resolves.toEqual(memberList);
    expect(calls()[0]![0]).toBe(`http://api/orgs/${ORG}/members`);
  });

  it('PATCH role and DELETE member', async () => {
    const { api, calls } = client(
      json({ id: 'm', organizationId: ORG, userId: USER, role: 'viewer', createdAt: 'x' }),
      new Response(null, { status: 204 }),
    );
    await api.members.changeRole(ORG, USER, 'viewer');
    await api.members.remove(ORG, USER);
    expect(calls().map(([u, i]) => [i.method, u])).toEqual([
      ['PATCH', `http://api/orgs/${ORG}/members/${USER}`],
      ['DELETE', `http://api/orgs/${ORG}/members/${USER}`],
    ]);
    expect(JSON.parse(calls()[0]![1].body as string)).toEqual({ role: 'viewer' });
  });

  it('creates and revokes invitations', async () => {
    const { api, calls } = client(
      json(invitation, 201),
      json({ ...invitation, status: 'revoked' }),
    );
    await api.invitations.create(ORG, { email: 'a@b.co', role: 'member' });
    await api.invitations.revoke(ORG, invitation.id);
    expect(calls().map(([u, i]) => [i.method, u])).toEqual([
      ['POST', `http://api/orgs/${ORG}/invitations`],
      ['POST', `http://api/orgs/${ORG}/invitations/${invitation.id}/revoke`],
    ]);
    expect(JSON.parse(calls()[0]![1].body as string)).toEqual({ email: 'a@b.co', role: 'member' });
  });

  it('parses a known 409 reason and ignores unknown ones', async () => {
    const { api } = client(
      json({ error: { code: 'CONFLICT', message: 'x', reason: 'LAST_OWNER' } }, 409),
      json({ error: { code: 'CONFLICT', message: 'x', reason: '<b>bogus</b>' } }, 409),
    );
    const e1 = await api.members.remove(ORG, USER).catch((e: unknown) => e);
    const e2 = await api.members.remove(ORG, USER).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(ApiError);
    expect((e1 as ApiError).reason).toBe('LAST_OWNER');
    expect((e2 as ApiError).reason).toBeUndefined();
  });
});

describe('fetchAllPages', () => {
  afterEach(() => vi.restoreAllMocks());

  it('follows nextCursor to the end', async () => {
    const load = vi
      .fn()
      .mockResolvedValueOnce({ items: [1, 2], nextCursor: 'n1' })
      .mockResolvedValueOnce({ items: [3], nextCursor: null });
    await expect(fetchAllPages(load)).resolves.toEqual({ items: [1, 2, 3], truncated: false });
    expect(load).toHaveBeenNthCalledWith(1, { limit: 100 });
    expect(load).toHaveBeenNthCalledWith(2, { limit: 100, cursor: 'n1' });
  });

  it('stops at the page cap', async () => {
    const load = vi.fn().mockResolvedValue({ items: [1], nextCursor: 'more' });
    const r = await fetchAllPages(load);
    expect(r.truncated).toBe(true);
    expect(load).toHaveBeenCalledTimes(20);
  });
});
