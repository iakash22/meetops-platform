import { API_ERROR_REASONS, CONFLICT_REASONS, NOT_FOUND_REASONS } from '@meetops/contracts';

import { ApiError, createApiClient, type ApiErrorReason } from '../src/api/client';

type Call = { url: string; init: RequestInit };

function fakeFetch(status: number, body?: unknown) {
  const calls: Call[] = [];
  const impl = ((url: string, init: RequestInit) => {
    calls.push({ url, init });
    const text = body === undefined ? '' : JSON.stringify(body);
    return Promise.resolve({ status, text: () => Promise.resolve(text) } as Response);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const ORG = {
  id: '00000000-0000-4000-8000-0000000000a2',
  name: 'Second Org',
  slug: 'second-org',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

describe('createApiClient', () => {
  it('signup expects 202 with a message and no session', async () => {
    const { impl, calls } = fakeFetch(202, { message: 'Check your email to continue.' });
    const api = createApiClient({ baseUrl: 'https://api.example.test/', fetchImpl: impl });
    await expect(
      api.signup({ name: 'Ada', email: 'ada@example.com', password: 'long enough pw' }),
    ).resolves.toEqual({
      message: 'Check your email to continue.',
    });
    expect(calls[0]?.url).toBe('https://api.example.test/auth/signup');
    expect(calls[0]?.init.method).toBe('POST');
  });

  it('switchOrganization posts to /orgs/switch and returns { organization, role }', async () => {
    const { impl, calls } = fakeFetch(200, { organization: ORG, role: 'admin' });
    const api = createApiClient({
      baseUrl: 'https://api.example.test',
      fetchImpl: impl,
      getAccessToken: () => Promise.resolve('tok'),
    });
    const res = await api.switchOrganization({ organizationId: ORG.id });
    expect(res).toEqual({ organization: ORG, role: 'admin' });
    const call = calls[0];
    expect(call?.url).toBe('https://api.example.test/orgs/switch');
    expect(call?.init.body).toBe(JSON.stringify({ organizationId: ORG.id }));
  });

  it('sends the token only in the Authorization header and never sends cookies', async () => {
    const { impl, calls } = fakeFetch(200, { items: [], nextCursor: null });
    const api = createApiClient({
      baseUrl: 'https://api.example.test',
      fetchImpl: impl,
      getAccessToken: () => Promise.resolve('secret-token'),
    });
    await api.listOrganizations();
    const call = calls[0];
    expect(call?.url).not.toContain('secret-token');
    expect((call?.init.headers as Record<string, string>).authorization).toBe(
      'Bearer secret-token',
    );
    expect(call?.init.credentials).toBe('omit');
  });

  it('maps the ApiErrorEnvelope to ApiError', async () => {
    const { impl } = fakeFetch(404, {
      error: { code: 'NOT_FOUND', message: 'Not found.', requestId: 'req-1' },
    });
    const api = createApiClient({ baseUrl: 'https://api.example.test', fetchImpl: impl });
    const err = await api.switchOrganization({ organizationId: ORG.id }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 404, code: 'NOT_FOUND', requestId: 'req-1' });
  });

  it('falls back to a status-derived code for non-envelope errors, and handles 204 logout', async () => {
    const bad = createApiClient({ baseUrl: 'https://x.test', fetchImpl: fakeFetch(502).impl });
    await expect(bad.getSession()).rejects.toMatchObject({ status: 502, code: 'INTERNAL' });
    const ok = createApiClient({ baseUrl: 'https://x.test', fetchImpl: fakeFetch(204).impl });
    await expect(ok.logout()).resolves.toBeUndefined();
  });

  it('accepts every contracts error reason (v0.4 CONFLICT and NOT_FOUND) on ApiError.reason', async () => {
    // Type-level: the mobile reason type must stay identical to the contracts list, in both directions.
    type ContractsReason = (typeof API_ERROR_REASONS)[number];
    const toMobile = (r: ContractsReason): ApiErrorReason => r;
    const toContracts = (r: ApiErrorReason): ContractsReason => r;
    expect(API_ERROR_REASONS.length).toBeGreaterThan(0);

    const cases = [
      ...CONFLICT_REASONS.map((reason) => ({ status: 409, code: 'CONFLICT' as const, reason })),
      ...NOT_FOUND_REASONS.map((reason) => ({ status: 404, code: 'NOT_FOUND' as const, reason })),
    ];
    expect(cases).toHaveLength(API_ERROR_REASONS.length);
    for (const { status, code, reason } of cases) {
      const { impl } = fakeFetch(status, { error: { code, message: 'Nope.', reason } });
      const api = createApiClient({ baseUrl: 'https://api.example.test', fetchImpl: impl });
      const err = await api.getSession().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect(err).toMatchObject({ status, code, reason: toContracts(toMobile(reason)) });
    }
  });
});
