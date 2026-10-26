import { describe, expect, it, vi } from 'vitest';
import { ApiError, assertHttpsUrl, createApiClient } from '@/lib/api/client';
import { completeResponse, consentSettings, downloadUrlResponse } from './fixtures/data';

const ORG = '00000000-0000-4000-8000-000000000001';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const client = (fetchMock: ReturnType<typeof vi.fn>) =>
  createApiClient({
    baseUrl: 'http://api',
    fetch: fetchMock as unknown as typeof fetch,
    getCsrfToken: () => 'c1',
  });

describe('uploads API client', () => {
  it('complete POSTs exactly {} to .../uploads/:id/complete', async () => {
    const f = vi.fn().mockResolvedValue(json(completeResponse));
    const res = await client(f).storage.completeUpload(ORG, 'fo/1');
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://api/orgs/${ORG}/uploads/fo%2F1/complete`);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    expect(res.scanStatus).toBe('pending');
  });

  it('download-url is a GET and never cached by the client', async () => {
    const f = vi.fn().mockImplementation(() => Promise.resolve(json(downloadUrlResponse)));
    const api = client(f);
    await api.storage.getDownloadUrl(ORG, 'fo_1');
    await api.storage.getDownloadUrl(ORG, 'fo_1');
    expect(f).toHaveBeenCalledTimes(2);
    expect((f.mock.calls[0] as [string])[0]).toBe(
      `http://api/orgs/${ORG}/uploads/fo_1/download-url`,
    );
  });

  it.each(['CONSENT_REQUIRED', 'CONSENT_VERSION_UNSUPPORTED', 'CONSENT_INVALID'])(
    'parses 422 reason %s',
    async (reason) => {
      const f = vi
        .fn()
        .mockResolvedValue(
          json({ error: { code: 'VALIDATION_FAILED', message: 'x', reason } }, 422),
        );
      const err = await client(f)
        .storage.initUpload(ORG, {} as never)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ApiError);
      expect((err as ApiError).reason).toBe(reason);
    },
  );

  it('consent settings GET and PATCH', async () => {
    const f = vi
      .fn()
      .mockResolvedValueOnce(json(consentSettings))
      .mockResolvedValueOnce(json({ ...consentSettings, retentionDays: 30 }));
    const api = client(f);
    await api.consentSettings.get(ORG);
    const res = await api.consentSettings.update(ORG, { retentionDays: 30 });
    const [url, init] = f.mock.calls[1] as [string, RequestInit];
    expect(url).toBe(`http://api/orgs/${ORG}/settings/consent`);
    expect(init.method).toBe('PATCH');
    expect(JSON.parse(init.body as string)).toEqual({ retentionDays: 30 });
    expect(res.retentionDays).toBe(30);
  });

  it('refuses a non-https presigned PUT', async () => {
    const api = client(vi.fn());
    await expect(
      api.storage.putToPresignedUrl(
        { url: 'http://x/y', method: 'PUT', expiresAt: '2026-10-21T18:00:00.000Z' },
        new Blob(['a']),
      ),
    ).rejects.toBeInstanceOf(ApiError);
  });

  it.each([
    'http://x/y',
    'javascript:alert(1)',
    '//evil/x',
    '/relative',
    'httpsx://x',
    'not a url',
  ])('assertHttpsUrl rejects %s', (u) => {
    expect(() => assertHttpsUrl(u)).toThrow(ApiError);
  });

  it('assertHttpsUrl accepts an absolute https URL', () => {
    expect(() => assertHttpsUrl('https://bucket.example/k?sig=1')).not.toThrow();
  });

  it('refuses a non-https PUT on the XHR (progress) path before xhr.open or any send', async () => {
    const open = vi.spyOn(XMLHttpRequest.prototype, 'open');
    const send = vi.spyOn(XMLHttpRequest.prototype, 'send');
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const api = createApiClient({ baseUrl: 'http://api', getCsrfToken: () => 'c1' });
    await expect(
      api.storage.putToPresignedUrl(
        { url: 'http://storage/k', method: 'PUT', expiresAt: '2026-10-21T18:00:00.000Z' },
        new Blob(['a']),
        () => undefined,
      ),
    ).rejects.toMatchObject({ status: 0, code: 'BAD_REQUEST' });
    expect(open).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    open.mockRestore();
    send.mockRestore();
    fetchSpy.mockRestore();
  });

  it('refuses a non-https PUT on the fetch path without calling fetch', async () => {
    const f = vi.fn();
    await expect(
      client(f).storage.putToPresignedUrl(
        { url: 'http://storage/k', method: 'PUT', expiresAt: '2026-10-21T18:00:00.000Z' },
        new Blob(['a']),
      ),
    ).rejects.toBeInstanceOf(ApiError);
    expect(f).not.toHaveBeenCalled();
  });

  it('maps a 413 PAYLOAD_TOO_LARGE envelope to its code', async () => {
    const f = vi
      .fn()
      .mockResolvedValue(
        json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'too big', requestId: 'r' } }, 413),
      );
    await expect(
      client(f).storage.initUpload(ORG, {
        fileName: 'a.mp4',
        contentType: 'video/mp4',
        sizeBytes: 1,
        sha256Base64: 'x',
      } as never),
    ).rejects.toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
  });
});
