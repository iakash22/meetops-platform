import { describe, expect, it, vi } from 'vitest';
import { createApiClient } from '@/lib/api/client';

const ORG = '00000000-0000-4000-8000-000000000001';
const res = (body: unknown, status = 200) =>
  ({
    ok: status < 400,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
    headers: new Headers(),
  }) as Response;
const unauth = () => res({ error: { code: 'UNAUTHENTICATED', message: 'x', requestId: 'r' } }, 401);

describe('single-flight session refresh on 401', () => {
  it('concurrent 401s share one /auth/session check, then each retries once', async () => {
    let sessionOk = false;
    const calls: string[] = [];
    let resolveSession!: () => void;
    const gate = new Promise<void>((r) => (resolveSession = r));
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith('/auth/session')) {
        await gate;
        sessionOk = true;
        return res({});
      }
      return sessionOk ? res({ items: [], nextCursor: null }) : unauth();
    });
    const api = createApiClient({
      baseUrl: 'http://api',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const handler = vi.fn();
    api.onUnauthorized(handler);
    const all = Promise.all([1, 2, 3].map(() => api.meetings.list(ORG)));
    await vi.waitFor(() =>
      expect(calls.filter((u) => u.endsWith('/auth/session'))).toHaveLength(1),
    );
    resolveSession();
    await expect(all).resolves.toHaveLength(3);
    expect(calls.filter((u) => u.endsWith('/auth/session'))).toHaveLength(1);
    expect(handler).not.toHaveBeenCalled();
  });

  it('a failed refresh fires onUnauthorized once for the whole burst', async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(async () => unauth());
    const api = createApiClient({
      baseUrl: 'http://api',
      fetch: fetchMock as unknown as typeof fetch,
    });
    const handler = vi.fn();
    api.onUnauthorized(handler);
    await Promise.allSettled([1, 2, 3].map(() => api.meetings.list(ORG)));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/auth/session'))).toHaveLength(
      1,
    );
  });
});
