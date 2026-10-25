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

  it('refreshes the CSRF token once on a 403 CSRF_INVALID', async () => {
    const csrf403 = { error: { code: 'CSRF_INVALID', message: 'csrf', requestId: 'r1' } };
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

  it('on CSRF_INVALID retry fetches a fresh token from /auth/csrf instead of re-reading the cookie', async () => {
    document.cookie = 'meetops_csrf=stale; path=/';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: 'CSRF_INVALID', message: 'x', requestId: 'r6' } }, 403),
      )
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'fresh' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = createApiClient({ baseUrl: 'http://api', fetch: fetchMock });
    await api.request('POST', '/x', {});
    const calls = fetchMock.mock.calls as Call[];
    expect(calls.map((c) => c[0])).toEqual([
      'http://api/x',
      'http://api/auth/csrf',
      'http://api/x',
    ]);
    expect(headersOf(calls[0]![1])[CSRF_HEADER]).toBe('stale');
    expect(headersOf(calls[2]![1])[CSRF_HEADER]).toBe('fresh');
  });

  it('does not retry a FORBIDDEN 403 even when details mention csrf (pre-v0.3 shape)', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'tok' }))
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: 'FORBIDDEN',
              message: 'no',
              requestId: 'r3',
              details: [{ path: 'x-csrf-token', message: 'invalid' }],
            },
          },
          403,
        ),
      );
    const api = createApiClient({ baseUrl: 'http://api', fetch: fetchMock });
    const err = (await api.request('POST', '/x', {}).catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('FORBIDDEN');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('retries CSRF_INVALID only once, then surfaces it as a known code', async () => {
    const csrf403 = jsonResponse(
      { error: { code: 'CSRF_INVALID', message: 'x', requestId: 'r4' } },
      403,
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'a' }))
      .mockResolvedValueOnce(csrf403)
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'b' }))
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: 'CSRF_INVALID', message: 'x', requestId: 'r5' } }, 403),
      );
    const api = createApiClient({ baseUrl: 'http://api', fetch: fetchMock });
    const err = (await api.request('POST', '/x', {}).catch((e: unknown) => e)) as ApiError;
    expect(err.code).toBe('CSRF_INVALID');
    expect(err.requestId).toBe('r5');
    expect(fetchMock).toHaveBeenCalledTimes(4);
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
    const body = {
      filename: 'rec.webm',
      mimeType: 'audio/webm',
      sizeBytes: 1024,
      checksumSha256: 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=',
    };
    const res = await api.storage.createUpload('00000000-0000-4000-8000-000000000001', body);
    expect(res.upload.method).toBe('PUT');
    expect(res.upload.url.startsWith('https://')).toBe(true);
    expect(typeof res.upload.expiresAt).toBe('string');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://api/orgs/00000000-0000-4000-8000-000000000001/uploads');
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
    await api.meetings.list('00000000-0000-4000-8000-000000000001').catch(() => undefined);
    expect(handler).toHaveBeenCalledTimes(1);
    await api.auth.session().catch(() => undefined);
    expect(handler).toHaveBeenCalledTimes(1);
    off();
    await api.meetings.list('00000000-0000-4000-8000-000000000001').catch(() => undefined);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('builds task filter query params', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [], nextCursor: null }));
    const api = createApiClient({ baseUrl: 'http://api', fetch: fetchMock });
    await api.tasks.list('00000000-0000-4000-8000-000000000001', {
      status: 'cancelled',
      assigneeId: '10000000-0000-4000-8000-000000000001',
      dueBefore: '2026-10-25T18:29:59.999Z',
    });
    expect((fetchMock.mock.calls[0] as Call)[0]).toBe(
      'http://api/orgs/00000000-0000-4000-8000-000000000001/tasks?status=cancelled&assigneeId=10000000-0000-4000-8000-000000000001&dueBefore=2026-10-25T18%3A29%3A59.999Z',
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

describe('organizations.create (POST /orgs)', () => {
  afterEach(clearCookies);

  it('POSTs {name} with CSRF and refetches the token after the session rotates', async () => {
    const created = {
      organization: { id: '00000000-0000-4000-8000-000000000009', name: 'Initech' },
      role: 'owner',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'before' }))
      .mockResolvedValueOnce(jsonResponse(created, 201))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'after' }))
      .mockResolvedValue(jsonResponse({}, 200));
    const api = createApiClient({ baseUrl: 'http://api', fetch: fetchMock });
    await expect(api.organizations.create({ name: 'Initech' })).resolves.toEqual(created);
    await api.request('POST', '/orgs/00000000-0000-4000-8000-000000000009/projects', { name: 'p' });
    const calls = fetchMock.mock.calls as Call[];
    expect(calls.map((c) => c[0])).toEqual([
      'http://api/auth/csrf',
      'http://api/orgs',
      'http://api/auth/csrf',
      'http://api/orgs/00000000-0000-4000-8000-000000000009/projects',
    ]);
    expect(calls[1]![1].method).toBe('POST');
    expect(JSON.parse(calls[1]![1].body as string)).toEqual({ name: 'Initech' });
    expect(headersOf(calls[1]![1])[CSRF_HEADER]).toBe('before');
    expect(headersOf(calls[3]![1])[CSRF_HEADER]).toBe('after');
  });
});

describe('organizations.list (GET /orgs)', () => {
  it('returns the contracts ListOrganizationsResponse page', async () => {
    const page = {
      items: [
        {
          organization: { id: '00000000-0000-4000-8000-000000000001', name: 'Acme' },
          role: 'owner',
        },
      ],
      nextCursor: null,
    };
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(page));
    const api = createApiClient({ baseUrl: 'http://api', fetch: fetchMock });
    await expect(api.organizations.list()).resolves.toEqual(page);
    expect((fetchMock.mock.calls as Call[])[0]![0]).toBe('http://api/orgs');
  });
});

describe('extension.pair (POST /auth/extension/pair)', () => {
  afterEach(clearCookies);

  it('POSTs the ExtensionPairRequest with CSRF', async () => {
    const body = {
      extensionId: 'a'.repeat(32),
      deviceId: '00000000-0000-4000-8000-0000000000dd',
      nonce: 'N'.repeat(43),
    };
    const res = {
      pairingCode: 'P'.repeat(40),
      expiresAt: '2026-10-01T00:01:00.000Z',
      organizationId: '00000000-0000-4000-8000-000000000001',
      organizationName: 'Acme',
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'tok' }))
      .mockResolvedValueOnce(jsonResponse(res, 201));
    const api = createApiClient({ baseUrl: 'http://api', fetch: fetchMock });
    await expect(api.extension.pair(body)).resolves.toEqual(res);
    const calls = fetchMock.mock.calls as Call[];
    expect(calls[1]![0]).toBe('http://api/auth/extension/pair');
    expect(calls[1]![1].method).toBe('POST');
    expect(JSON.parse(calls[1]![1].body as string)).toEqual(body);
    expect(headersOf(calls[1]![1])[CSRF_HEADER]).toBe('tok');
  });
});

describe('organizations.switch (POST /orgs/switch, BE-GAP-2)', () => {
  afterEach(clearCookies);

  it('posts to /orgs/switch, returns { organization, role } and drops the old CSRF token', async () => {
    const orgId = '00000000-0000-4000-8000-000000000002';
    const switched = { organization: { ...session.organizations[1]! }, role: 'member' };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'before' }))
      .mockResolvedValueOnce(jsonResponse(switched))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'after' }))
      .mockResolvedValue(jsonResponse({}));
    const api = createApiClient({ baseUrl: 'http://api', fetch: fetchMock });
    await expect(api.organizations.switch({ organizationId: orgId })).resolves.toEqual(switched);
    await api.request('POST', '/x', {});
    const calls = fetchMock.mock.calls as Call[];
    expect(calls.map((c) => c[0])).toEqual([
      'http://api/auth/csrf',
      'http://api/orgs/switch',
      'http://api/auth/csrf',
      'http://api/x',
    ]);
    expect(calls.some((c) => c[0].endsWith('/auth/switch-org'))).toBe(false);
    expect(JSON.parse(calls[1]![1].body as string)).toEqual({ organizationId: orgId });
    expect(headersOf(calls[1]![1])[CSRF_HEADER]).toBe('before');
    expect(headersOf(calls[3]![1])[CSRF_HEADER]).toBe('after');
  });
});

describe('auth lifecycle endpoints', () => {
  afterEach(clearCookies);

  it('signup resolves the 202 { message } body and never caches a session token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'pre-session' }))
      .mockResolvedValueOnce(jsonResponse({ message: 'Check your email to continue.' }, 202))
      .mockResolvedValue(jsonResponse({}));
    const api = createApiClient({ baseUrl: 'http://api', fetch: fetchMock });
    await expect(
      api.auth.signup({ name: 'Ada', email: 'ada@example.com', password: 'long-enough-pass' }),
    ).resolves.toEqual({ message: 'Check your email to continue.' });
    await api.request('POST', '/x', {});
    const calls = fetchMock.mock.calls as Call[];
    expect(calls.map((c) => c[0])).toEqual([
      'http://api/auth/csrf',
      'http://api/auth/signup',
      'http://api/x',
    ]);
    expect(headersOf(calls[2]![1])[CSRF_HEADER]).toBe('pre-session');
  });

  it.each([
    ['verifyEmail', '/auth/verify-email', { token: 't'.repeat(40) }, 204],
    [
      'resetPassword',
      '/auth/reset-password',
      { token: 't'.repeat(40), password: 'x'.repeat(12) },
      204,
    ],
    ['resendVerification', '/auth/resend-verification', { email: 'ada@example.com' }, 202],
  ] as const)('%s posts to %s with CSRF', async (method, path, body, status) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'tok' }))
      .mockResolvedValueOnce(new Response(null, { status }));
    const api = createApiClient({ baseUrl: 'http://api', fetch: fetchMock });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect((api.auth[method] as (b: any) => Promise<void>)(body)).resolves.toBeUndefined();
    const calls = fetchMock.mock.calls as Call[];
    expect(calls[1]![0]).toBe(`http://api${path}`);
    expect(calls[1]![1].method).toBe('POST');
    expect(JSON.parse(calls[1]![1].body as string)).toEqual(body);
    expect(headersOf(calls[1]![1])[CSRF_HEADER]).toBe('tok');
  });

  it('a 400 from verify-email is an ApiError and does not fire onUnauthorized', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'tok' }))
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { code: 'BAD_REQUEST', message: 'Verification link is invalid' } },
          400,
        ),
      );
    const api = createApiClient({ baseUrl: 'http://api', fetch: fetchMock });
    const handler = vi.fn();
    api.onUnauthorized(handler);
    await expect(api.auth.verifyEmail({ token: 't'.repeat(40) })).rejects.toMatchObject({
      status: 400,
      code: 'BAD_REQUEST',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each([
    ['logout', '/auth/logout'],
    ['logoutAll', '/auth/logout-all'],
  ] as const)('%s posts to %s and refetches the CSRF token afterwards', async (method, path) => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'old' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'new' }))
      .mockResolvedValue(jsonResponse({}));
    const api = createApiClient({ baseUrl: 'http://api', fetch: fetchMock });
    const handler = vi.fn();
    api.onUnauthorized(handler);
    await api.auth[method]();
    await api.request('POST', '/x', {});
    const calls = fetchMock.mock.calls as Call[];
    expect(calls.map((c) => c[0])).toEqual([
      'http://api/auth/csrf',
      `http://api${path}`,
      'http://api/auth/csrf',
      'http://api/x',
    ]);
    expect(calls[1]![1].body).toBeUndefined();
    expect(headersOf(calls[1]![1])[CSRF_HEADER]).toBe('old');
    expect(headersOf(calls[3]![1])[CSRF_HEADER]).toBe('new');
    expect(handler).not.toHaveBeenCalled();
  });

  it('logout CSRF_INVALID is retried once with a fresh token', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'stale' }))
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: 'CSRF_INVALID', message: 'bad csrf' } }, 403),
      )
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'fresh' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const api = createApiClient({ baseUrl: 'http://api', fetch: fetchMock });
    await expect(api.auth.logout()).resolves.toBeUndefined();
    const calls = fetchMock.mock.calls as Call[];
    expect(calls.map((c) => c[0])).toEqual([
      'http://api/auth/csrf',
      'http://api/auth/logout',
      'http://api/auth/csrf',
      'http://api/auth/logout',
    ]);
    expect(headersOf(calls[3]![1])[CSRF_HEADER]).toBe('fresh');
  });

  it('invitations.accept posts the token to /invitations/accept; 401 stays in-page', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ csrfToken: 'tok' }))
      .mockResolvedValueOnce(
        jsonResponse({ error: { code: 'UNAUTHENTICATED', message: 'no session' } }, 401),
      );
    const api = createApiClient({ baseUrl: 'http://api', fetch: fetchMock });
    const handler = vi.fn();
    api.onUnauthorized(handler);
    await expect(api.invitations.accept({ token: 'i'.repeat(40) })).rejects.toMatchObject({
      status: 401,
    });
    const calls = fetchMock.mock.calls as Call[];
    expect(calls[1]![0]).toBe('http://api/invitations/accept');
    expect(JSON.parse(calls[1]![1].body as string)).toEqual({ token: 'i'.repeat(40) });
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('tasks.list query (ListTasksQuery)', () => {
  it('serializes unassigned=true, dueAfter/dueBefore and status arrays', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ items: [], nextCursor: null }));
    const api = createApiClient({ baseUrl: 'http://api', fetch: fetchMock });
    await api.tasks.list('o', {
      status: ['todo', 'in_progress'],
      unassigned: true,
      dueAfter: '2026-10-22T08:00:00.000Z',
      dueBefore: '2026-10-25T18:29:59.999Z',
    });
    const url = new URL((fetchMock.mock.calls[0] as Call)[0]);
    expect(url.searchParams.getAll('status')).toEqual(['todo', 'in_progress']);
    expect(url.searchParams.get('unassigned')).toBe('true');
    expect(url.searchParams.has('assigneeId')).toBe(false);
    expect(url.searchParams.get('dueAfter')).toBe('2026-10-22T08:00:00.000Z');
    expect(url.searchParams.get('dueBefore')).toBe('2026-10-25T18:29:59.999Z');
  });
});
