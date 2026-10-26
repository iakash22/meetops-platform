import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from '@/lib/api/client';
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
});
