import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from '@/lib/api/client';
import { meetings } from './fixtures/data';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('api client', () => {
  it('sends auth header and parses json', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(meetings));
    const api = createApiClient({
      baseUrl: 'http://api/',
      fetch: fetchMock,
      getToken: () => 'tok',
    });
    await expect(api.meetings.list('org 1')).resolves.toEqual(meetings);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api/orgs/org%201/meetings');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  });

  it('throws ApiError on non-2xx', async () => {
    const api = createApiClient({
      baseUrl: 'http://api',
      fetch: vi.fn().mockResolvedValue(jsonResponse({ e: 1 }, 401)),
    });
    await expect(api.auth.login({ email: 'a@b.co', password: 'x' })).rejects.toBeInstanceOf(
      ApiError,
    );
  });
});
