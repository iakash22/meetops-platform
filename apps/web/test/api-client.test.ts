import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, CSRF_HEADER, createApiClient, readCsrfCookie } from '@/lib/api/client';
import { meetings, uploadResponse } from './fixtures/data';

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

type Call = [string, RequestInit];
const headersOf = (init: RequestInit) => init.headers as Record<string, string>;

function clearCookies() {
  for (const c of document.cookie.split(';')) {
    const name = c.split('=')[0]?.trim();
    if (name) document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`;
  }
}

describe('api client (cookie session + CSRF)', () => {
  afterEach(clearCookies);

  it('GET uses credentials include, no bearer and no CSRF header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(meetings));
    const api = createApiClient({ baseUrl: 'http://api/', fetch: fetchMock });
    await expect(api.meetings.list('org 1')).resolves.toEqual(meetings);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as Call;
    expect(url).toBe('http://api/orgs/org%201/meetings');
    expect(init.credentials).toBe('include');
    expect(headersOf(init).Authorization).toBeUndefined();
    expect(headersOf(init)[CSRF_HEADER]).toBeUndefined();
  });

  it('mutations fetch the token from GET /auth/csrf and send X-CSRF-Token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'csrf-1' }))
      .mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));
    const api = createApiClient({ baseUrl: 'http://api', fetch: fetchMock });
    await api.auth.forgotPassword({ email: 'a@b.co' });
    await api.auth.forgotPassword({ email: 'a@b.co' });
    const calls = fetchMock.mock.calls as Call[];
    expect(calls.map((c) => c[0])).toEqual([
      'http://api/auth/csrf',
      'http://api/auth/forgot-password',
      'http://api/auth/forgot-password',
    ]);
    expect(calls[0]![1].credentials).toBe('include');
    for (const [, init] of calls.slice(1)) {
      expect(init.credentials).toBe('include');
      expect(headersOf(init)[CSRF_HEADER]).toBe('csrf-1');
      expect(headersOf(init).Authorization).toBeUndefined();
    }
  });

  it('prefers the double-submit csrf cookie when present', async () => {
    document.cookie = 'meetops_csrf=from-cookie; path=/';
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
    const api = createApiClient({ baseUrl: 'http://api', fetch: fetchMock });
    await api.auth.forgotPassword({ email: 'a@b.co' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(headersOf((fetchMock.mock.calls[0] as Call)[1])[CSRF_HEADER]).toBe('from-cookie');
  });

  it('refreshes the CSRF token once on 403', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'old' }))
      .mockResolvedValueOnce(jsonResponse({ error: 'csrf' }, 403))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'new' }))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    const api = createApiClient({ baseUrl: 'http://api', fetch: fetchMock });
    await expect(api.auth.forgotPassword({ email: 'a@b.co' })).resolves.toEqual({ ok: true });
    expect(headersOf((fetchMock.mock.calls[3] as Call)[1])[CSRF_HEADER]).toBe('new');
  });

  it('throws ApiError on non-2xx', async () => {
    const api = createApiClient({
      baseUrl: 'http://api',
      fetch: vi.fn().mockResolvedValue(jsonResponse({ e: 1 }, 401)),
      getCsrfToken: () => 't',
    });
    await expect(api.auth.login({ email: 'a@b.co', password: 'x' })).rejects.toBeInstanceOf(
      ApiError,
    );
  });

  it('parses csrf cookies', () => {
    expect(readCsrfCookie('a=1; __Host-meetops_csrf=abc%3D; b=2')).toBe('abc=');
    expect(readCsrfCookie('a=1')).toBeNull();
  });
});

describe('csrf endpoint response', () => {
  it('only reads the csrfToken field', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ token: 'ignored' }))
      .mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));
    const api = createApiClient({ baseUrl: 'http://api', fetch: fetchMock });
    await api.auth.forgotPassword({ email: 'a@b.co' });
    const init = (fetchMock.mock.calls[1] as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)['X-CSRF-Token']).toBeUndefined();
  });
});

describe('ApiError envelope parsing', () => {
  it('parses code, message and requestId without method/path', async () => {
    const api = createApiClient({
      baseUrl: 'http://api',
      fetch: vi
        .fn()
        .mockResolvedValue(
          jsonResponse({ error: { code: 'FORBIDDEN', message: 'Nope', requestId: 'req_1' } }, 403),
        ),
    });
    const err = (await api.meetings.list('o').catch((e: unknown) => e)) as ApiError;
    expect(err).toMatchObject({
      status: 403,
      code: 'FORBIDDEN',
      message: 'Nope',
      requestId: 'req_1',
    });
    expect(err.message).not.toContain('/orgs');
    expect(err.message).not.toContain('GET');
  });

  it('falls back to UNKNOWN for non-json or unknown codes', () => {
    expect(ApiError.fromResponse(500, undefined).code).toBe('UNKNOWN');
    expect(ApiError.fromResponse(500, { error: { code: 'WAT' } }).code).toBe('UNKNOWN');
    expect(ApiError.fromResponse(500, { error: { code: 'INTERNAL' } }).message).toBe(
      'Request failed',
    );
  });

  it('does not throw on an invalid json error body', async () => {
    const api = createApiClient({
      baseUrl: 'http://api',
      fetch: vi.fn().mockResolvedValue(new Response('<html>oops', { status: 502 })),
    });
    const err = (await api.meetings.list('o').catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.message).toBe('Request failed');
  });
});

describe('CSRF header by method', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'] as const)(
    'sends X-CSRF-Token on %s',
    async (method) => {
      const fetchMock = vi
        .fn()
        .mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));
      const api = createApiClient({
        baseUrl: 'http://api',
        fetch: fetchMock,
        getCsrfToken: () => 'c1',
      });
      await api.request(method, '/x', method === 'DELETE' ? undefined : { a: 1 });
      const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
      expect(init.method).toBe(method);
      expect(init.credentials).toBe('include');
      expect((init.headers as Record<string, string>)[CSRF_HEADER]).toBe('c1');
    },
  );

  it('does not send X-CSRF-Token on GET', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(jsonResponse({ ok: true })));
    const getCsrfToken = vi.fn(() => 'c1');
    const api = createApiClient({ baseUrl: 'http://api', fetch: fetchMock, getCsrfToken });
    await api.request('GET', '/x');
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)[CSRF_HEADER]).toBeUndefined();
    expect(getCsrfToken).not.toHaveBeenCalled();
  });
});

describe('uploads (PresignedUrlDto)', () => {
  it('POSTs CreateUploadRequest with CSRF and returns CreateUploadResponse', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(uploadResponse, 201));
    const api = createApiClient({
      baseUrl: 'http://api',
      fetch: fetchMock,
      getCsrfToken: () => 'c1',
    });
    const body = { filename: 'rec.webm', mimeType: 'audio/webm', sizeBytes: 1024, checksumSha256: 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=' };
    const res = await api.storage.createUpload('org_1', body);
    expect(res.upload.method).toBe('PUT');
    expect(res.upload.url.startsWith('https://')).toBe(true);
    expect(typeof res.upload.expiresAt).toBe('string');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api/orgs/org_1/uploads');
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual(body);
    expect((init.headers as Record<string, string>)[CSRF_HEADER]).toBe('c1');
  });
});

describe('AUTH_FAILED code', () => {
  it('is recognised from the envelope', () => {
    expect(
      ApiError.fromResponse(401, { error: { code: 'AUTH_FAILED', message: 'x', requestId: 'r' } })
        .code,
    ).toBe('AUTH_FAILED');
  });
});
