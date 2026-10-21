import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ApiError,
  CSRF_HEADER,
  CsrfUnavailableError,
  createApiClient,
  readCsrfCookie,
} from '@/lib/api/client';
import { meetings, session, uploadResponse } from './fixtures/data';

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

  it('refreshes the CSRF token once on a CSRF-specific 403', async () => {
    const csrf403 = {
      error: {
        code: 'FORBIDDEN',
        message: 'csrf',
        requestId: 'r1',
        details: [{ path: 'x-csrf-token', message: 'invalid' }],
      },
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'old' }))
      .mockResolvedValueOnce(jsonResponse(csrf403, 403))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'new' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = createApiClient({ baseUrl: 'http://api', fetch: fetchMock });
    await expect(api.auth.forgotPassword({ email: 'a@b.co' })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(headersOf((fetchMock.mock.calls[3] as Call)[1])[CSRF_HEADER]).toBe('new');
  });

  it('does not retry a plain FORBIDDEN 403', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'tok' }))
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: 'FORBIDDEN', message: 'no', requestId: 'r2' } }, 403),
      );
    const api = createApiClient({ baseUrl: 'http://api', fetch: fetchMock });
    const err = (await api.request('POST', '/x', {}).catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('FORBIDDEN');
    expect(err.isCsrfFailure).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
  it('only reads the csrfToken field and refuses to send without a token', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse({ token: 'ignored' }));
    const api = createApiClient({ baseUrl: 'http://api', fetch: fetchMock });
    await expect(api.auth.forgotPassword({ email: 'a@b.co' })).rejects.toBeInstanceOf(
      CsrfUnavailableError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0] as Call)[0]).toBe('http://api/auth/csrf');
  });

  it('throws before sending when the csrf endpoint fails', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response('', { status: 500 }));
    const api = createApiClient({ baseUrl: 'http://api', fetch: fetchMock });
    await expect(api.request('DELETE', '/x')).rejects.toBeInstanceOf(CsrfUnavailableError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
    const body = { filename: 'rec.webm', mimeType: 'audio/webm', sizeBytes: 1024 };
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

describe('session, 401 and uploads', () => {
  it('uses the csrfToken from the login response for later mutations', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'pre-login-token-000' }))
      .mockResolvedValueOnce(jsonResponse(session))
      .mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
    const api = createApiClient({ baseUrl: 'http://api', fetch: fetchMock });
    await api.auth.login({ email: 'ada@example.com', password: 'x' });
    await api.request('POST', '/x', {});
    expect(headersOf((fetchMock.mock.calls[2] as Call)[1])[CSRF_HEADER]).toBe(session.csrfToken);
  });

  it('GET /auth/session with credentials', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: 1 }));
    const api = createApiClient({ baseUrl: 'http://api', fetch: fetchMock });
    await api.auth.session();
    const [url, init] = fetchMock.mock.calls[0] as Call;
    expect(url).toBe('http://api/auth/session');
    expect(init.credentials).toBe('include');
  });

  it('notifies onUnauthorized on 401 from app endpoints but not auth endpoints', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          jsonResponse({ error: { code: 'UNAUTHENTICATED', message: 'x', requestId: 'r' } }, 401),
        ),
      );
    const api = createApiClient({ baseUrl: 'http://api', fetch: fetchMock });
    const handler = vi.fn();
    const off = api.onUnauthorized(handler);
    await api.meetings.list('org_1').catch(() => undefined);
    expect(handler).toHaveBeenCalledTimes(1);
    await api.auth.session().catch(() => undefined);
    expect(handler).toHaveBeenCalledTimes(1);
    off();
    await api.meetings.list('org_1').catch(() => undefined);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('builds task filter query params', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [], nextCursor: null }));
    const api = createApiClient({ baseUrl: 'http://api', fetch: fetchMock });
    await api.tasks.list('org_1', { status: 'cancelled', assigneeId: 'usr_1', due: 'week' });
    expect((fetchMock.mock.calls[0] as Call)[0]).toBe(
      'http://api/orgs/org_1/tasks?status=cancelled&assigneeId=usr_1&due=week',
    );
  });

  it('PUTs to the presigned url without cookies or CSRF', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const api = createApiClient({
      baseUrl: 'http://api',
      fetch: fetchMock,
      getCsrfToken: () => 'c1',
    });
    const file = new Blob(['abc'], { type: 'audio/webm' });
    await api.storage.putToPresignedUrl(uploadResponse.upload, file);
    const [url, init] = fetchMock.mock.calls[0] as Call;
    expect(url).toBe(uploadResponse.upload.url);
    expect(init.method).toBe('PUT');
    expect(init.credentials).toBe('omit');
    expect(init.body).toBe(file);
    expect(headersOf(init)['Content-Type']).toBe('audio/webm');
    expect(headersOf(init)[CSRF_HEADER]).toBeUndefined();
  });

  it('refuses non-https presigned urls', async () => {
    const fetchMock = vi.fn();
    const api = createApiClient({ baseUrl: 'http://api', fetch: fetchMock });
    await expect(
      api.storage.putToPresignedUrl(
        { ...uploadResponse.upload, url: 'http://x/y' },
        new Blob(['a']),
      ),
    ).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
