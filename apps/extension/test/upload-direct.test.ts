import { describe, expect, it, vi } from 'vitest';
import { CURRENT_CONSENT_VERSION } from '@meetops/contracts/types';
import { directUploadValidators } from '../src/lib/auth/validate.js';
import { directUploadEnabled } from '../src/lib/features.js';
import {
  DIRECT_UPLOAD_PATHS,
  DirectUploadClient,
  DirectUploadError,
} from '../src/lib/upload-direct.js';
import { UploadApiError, type ApiFetch } from '../src/lib/upload-http.js';
import { hexToBase64, sha256Hex, type StorageTransport } from '../src/lib/upload.js';

const ORG = '00000000-0000-4000-8000-000000000001';
const FILE = '00000000-0000-4000-8000-0000000000f1';
const MEETING = '00000000-0000-4000-8000-0000000000a1';
const consent = {
  consentVersion: CURRENT_CONSENT_VERSION,
  attestedAt: '2026-10-26T10:00:00.000Z',
  method: 'all_parties_consented' as const,
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function setup(overrides: { init?: Response; complete?: Response; put?: number } = {}) {
  const blob = new Blob(['hello recording'], { type: 'audio/webm' });
  const checksum = hexToBase64(await sha256Hex(blob));
  const calls: { path: string; body: unknown }[] = [];
  const api: ApiFetch = vi.fn(async (path: string, init: RequestInit) => {
    calls.push({ path, body: JSON.parse(init.body as string) });
    if (path === DIRECT_UPLOAD_PATHS.init(ORG))
      return (
        overrides.init ??
        json(201, {
          fileObjectId: FILE,
          upload: {
            url: 'https://storage.example.com/put',
            method: 'PUT',
            headers: { 'x-amz-checksum-sha256': checksum, 'content-type': 'audio/webm' },
            expiresAt: '2026-10-26T10:05:00.000Z',
          },
        })
      );
    return overrides.complete ?? json(200, { fileObject: { id: FILE }, scanStatus: 'pending' });
  });
  const storage: StorageTransport = vi.fn(async () => ({ status: overrides.put ?? 200 }));
  const client = new DirectUploadClient({
    api,
    organizationId: async () => ORG,
    storage,
    ...directUploadValidators,
    retry: { maxAttempts: 1 },
  });
  return { blob, checksum, calls, api, storage, client };
}

describe('DirectUploadClient', () => {
  it('inits with consent and checksum, PUTs the blob, then completes', async () => {
    const s = await setup();
    const res = await s.client.upload({
      blob: s.blob,
      filename: 'meeting.webm',
      mimeType: 'audio/webm',
      meetingId: MEETING,
      consent,
    });
    expect(res).toEqual({ fileObjectId: FILE, scanStatus: 'pending' });
    expect(s.calls[0]).toEqual({
      path: `/orgs/${ORG}/uploads`,
      body: {
        filename: 'meeting.webm',
        mimeType: 'audio/webm',
        sizeBytes: s.blob.size,
        checksumSha256: s.checksum,
        meetingId: MEETING,
        consent,
      },
    });
    expect(s.storage).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://storage.example.com/put',
        method: 'PUT',
        body: s.blob,
      }),
    );
    expect(s.calls[1]).toEqual({ path: `/orgs/${ORG}/uploads/${FILE}/complete`, body: {} });
  });

  it('surfaces a 422 consent rejection as UploadApiError with the API code', async () => {
    const s = await setup({
      init: json(422, {
        error: { code: 'VALIDATION_FAILED', message: 'consent', requestId: 'r1' },
      }),
    });
    const err = await s.client
      .upload({ blob: s.blob, filename: 'a.webm', mimeType: 'audio/webm', consent })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UploadApiError);
    expect((err as UploadApiError).status).toBe(422);
    expect(s.storage).not.toHaveBeenCalled();
  });

  it('does not complete when the storage PUT fails', async () => {
    const s = await setup({ put: 403 });
    await expect(
      s.client.upload({ blob: s.blob, filename: 'a.webm', mimeType: 'audio/webm', consent }),
    ).rejects.toBeInstanceOf(DirectUploadError);
    expect(s.calls).toHaveLength(1);
  });

  it('rejects empty blobs and malformed init responses', async () => {
    const s = await setup({ init: json(201, { nope: true }) });
    await expect(
      s.client.upload({ blob: new Blob([]), filename: 'a.webm', mimeType: 'audio/webm', consent }),
    ).rejects.toMatchObject({ reason: 'empty' });
    await expect(
      s.client.upload({ blob: s.blob, filename: 'a.webm', mimeType: 'audio/webm', consent }),
    ).rejects.toMatchObject({ op: 'initUpload', reason: 'response' });
  });

  it('is off unless WXT_FEATURE_DIRECT_UPLOAD is true/1', () => {
    expect(directUploadEnabled({})).toBe(false);
    expect(directUploadEnabled({ WXT_FEATURE_DIRECT_UPLOAD: 'yes' })).toBe(false);
    expect(directUploadEnabled({ WXT_FEATURE_DIRECT_UPLOAD: '1' })).toBe(true);
  });
});
