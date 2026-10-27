import { createHttpAuthClient } from '../src/api/httpAuthClient';
import { AuthClientError } from '../src/auth/types';
import {
  createHttpMeetingsRepository,
  createHttpTasksRepository,
} from '../src/data/httpRepositories';
import { resolveApiBaseUrl } from '../src/services';

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

const ORG = '00000000-0000-4000-8000-0000000000a1';
const BASE = 'https://api.example.test';
const DEVICE = '0f8e2c1a-3b4d-4e5f-9a6b-7c8d9e0f1a2b';
const getDeviceId = () => Promise.resolve(DEVICE);
const bodyOf = (c?: Call) => JSON.parse(String(c?.init.body)) as Record<string, unknown>;

describe('createHttpAuthClient', () => {
  it('sends the stable deviceId on login, refresh and logout (ADR-005)', async () => {
    const { impl, calls } = fakeFetch(200, { tokens: {}, session: {} });
    const c = createHttpAuthClient({ baseUrl: BASE, fetchImpl: impl, getDeviceId });
    await c.login({ email: 'ada@example.com', password: 'long enough pw' });
    await c.refresh('r1');
    expect(bodyOf(calls[0])).toMatchObject({ email: 'ada@example.com', deviceId: DEVICE });
    expect(bodyOf(calls[1])).toEqual({ deviceId: DEVICE, refreshToken: 'r1' });
    const out = fakeFetch(204);
    await createHttpAuthClient({ baseUrl: BASE, fetchImpl: out.impl, getDeviceId }).logout('r2');
    expect(bodyOf(out.calls[0])).toEqual({ deviceId: DEVICE, refreshToken: 'r2' });
  });

  it('logs in with a JSON body, no cookies, no token in the URL', async () => {
    const { impl, calls } = fakeFetch(200, { tokens: { accessToken: 'a' }, session: {} });
    const c = createHttpAuthClient({ baseUrl: BASE, fetchImpl: impl, getDeviceId });
    await c.login({ email: 'ada@example.com', password: 'long enough pw' });
    expect(calls[0]?.url).toBe(`${BASE}/auth/mobile/token`);
    expect(calls[0]?.init.credentials).toBe('omit');
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('sends the access token only as a Bearer header', async () => {
    const { impl, calls } = fakeFetch(200, {});
    await createHttpAuthClient({ baseUrl: BASE, fetchImpl: impl, getDeviceId }).getSession(
      'secret-access',
    );
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe(
      'Bearer secret-access',
    );
    expect(calls[0]?.url).not.toContain('secret-access');
  });

  it('maps API errors to AuthClientError codes', async () => {
    const { impl } = fakeFetch(401, {
      error: { code: 'UNAUTHENTICATED', message: 'Invalid credentials.' },
    });
    const err = await createHttpAuthClient({ baseUrl: BASE, fetchImpl: impl, getDeviceId })
      .login({ email: 'ada@example.com', password: 'long enough pw' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AuthClientError);
    expect((err as AuthClientError).code).toBe('UNAUTHENTICATED');
  });

  it('maps a network failure to INTERNAL', async () => {
    const impl = (() =>
      Promise.reject(new TypeError('Network request failed'))) as unknown as typeof fetch;
    await expect(
      createHttpAuthClient({ baseUrl: BASE, fetchImpl: impl, getDeviceId }).refresh('r'),
    ).rejects.toMatchObject({
      code: 'INTERNAL',
    });
  });

  it('treats an already-revoked refresh token as a successful logout', async () => {
    const { impl } = fakeFetch(401, { error: { code: 'UNAUTHENTICATED', message: 'gone' } });
    await expect(
      createHttpAuthClient({ baseUrl: BASE, fetchImpl: impl, getDeviceId }).logout('r'),
    ).resolves.toBeUndefined();
  });
});

describe('http repositories', () => {
  it('lists tasks org-scoped by path and drops rows from other orgs', async () => {
    const { impl, calls } = fakeFetch(200, {
      items: [
        { id: '1', organizationId: ORG },
        { id: '2', organizationId: 'other' },
      ],
      nextCursor: null,
    });
    const repo = createHttpTasksRepository({
      baseUrl: BASE,
      getAccessToken: async () => 't',
      fetchImpl: impl,
    });
    const items = await repo.list(ORG);
    expect(items.map((t) => t.id)).toEqual(['1']);
    expect(calls[0]?.url).toBe(`${BASE}/orgs/${ORG}/tasks?limit=50`);
  });

  it('lists meetings for the org', async () => {
    const { impl, calls } = fakeFetch(200, { items: [], nextCursor: null });
    const repo = createHttpMeetingsRepository({
      baseUrl: BASE,
      getAccessToken: async () => 't',
      fetchImpl: impl,
    });
    await expect(repo.list(ORG)).resolves.toEqual([]);
    expect(calls[0]?.url).toBe(`${BASE}/orgs/${ORG}/meetings?limit=50`);
  });
});

describe('resolveApiBaseUrl', () => {
  it('accepts https and strips trailing slashes', () => {
    expect(resolveApiBaseUrl('https://api.x.test/', false)).toBe('https://api.x.test');
  });
  it('falls back to demo for empty or plain http in production', () => {
    expect(resolveApiBaseUrl(undefined, false)).toBeNull();
    expect(resolveApiBaseUrl('http://api.x.test', false)).toBeNull();
    expect(resolveApiBaseUrl('http://localhost:3000', false)).toBeNull();
  });
  it('allows loopback http in dev only', () => {
    expect(resolveApiBaseUrl('http://localhost:3000', true)).toBe('http://localhost:3000');
  });
});
