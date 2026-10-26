import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { InitUploadResponse, MAX_UPLOAD_BYTES } from '@meetops/contracts';
import { CompleteUploadResponse, DownloadUrlResponse } from '../src/modules/media/http/types.js';
import { consent, errorOf, mediaWorld, SHA_B64, type MediaWorld } from './media-helpers.js';

const body = (over: Record<string, unknown> = {}) => ({
  filename: 'call.webm',
  mimeType: 'audio/webm',
  sizeBytes: 1000,
  checksumSha256: SHA_B64,
  consent: consent(),
  ...over,
});

describe('uploads (init, complete, download-url)', () => {
  let w: MediaWorld;
  beforeEach(async () => {
    w = await mediaWorld();
  });
  afterEach(async () => w.app.close());
  const url = () => `/orgs/${w.org}/uploads`;
  const init = async (over: Record<string, unknown> = {}) => {
    const r = await w.member.post(url(), body(over));
    expect(r.statusCode).toBe(201);
    return r.json<InitUploadResponse>();
  };
  const keyOf = (id: string) => `organizations/${w.org}/uploads/${id}/source`;

  it('init returns a contract-valid presigned PUT and stores the consent attestation', async () => {
    const out = await init();
    expect(Value.Check(InitUploadResponse, out)).toBe(true);
    expect(out.upload.method).toBe('PUT');
    expect(out.upload.headers?.['content-length']).toBe('1000');
    expect(out.upload.headers?.['x-amz-checksum-sha256']).toBe(SHA_B64);
    expect(w.consents.rows).toHaveLength(1);
    expect(w.consents.rows[0]).toMatchObject({
      subjectType: 'upload',
      subjectId: out.fileObjectId,
      organizationId: w.org,
    });
  });

  it.each([
    ['missing consent', { consent: undefined }, 'CONSENT_REQUIRED'],
    ['malformed consent', { consent: { method: 'nope' } }, 'CONSENT_REQUIRED'],
    [
      'unsupported version',
      { consent: consent({ consentVersion: '2025-01' }) },
      'CONSENT_VERSION_UNSUPPORTED',
    ],
    [
      'attestedAt in the future',
      { consent: consent({ attestedAt: new Date(Date.now() + 3_600_000).toISOString() }) },
      'CONSENT_INVALID',
    ],
  ])('init with %s -> 422 %s and nothing created', async (_n, over, reason) => {
    const r = await w.member.post(url(), body(over));
    expect(r.statusCode).toBe(422);
    expect(errorOf(r)).toMatchObject({ code: 'VALIDATION_FAILED', reason });
    expect(w.consents.rows).toHaveLength(0);
  });

  it('rejects sizes over 1.4 GB (schema 400) and accepts exactly 1.4 GB', async () => {
    const r = await w.member.post(url(), body({ sizeBytes: MAX_UPLOAD_BYTES + 1 }));
    expect(r.statusCode).toBe(400);
    expect((await w.member.post(url(), body({ sizeBytes: MAX_UPLOAD_BYTES }))).statusCode).toBe(
      201,
    );
  });

  it('viewer 403, other org 404, unknown meeting 404', async () => {
    expect((await w.viewer.post(url(), body())).statusCode).toBe(403);
    expect((await w.other.post(url(), body())).statusCode).toBe(404);
    const r = await w.member.post(
      url(),
      body({ meetingId: '00000000-0000-4000-8000-0000000000ff' }),
    );
    expect(r.statusCode).toBe(404);
  });

  it('complete queues one job only after the object is stored', async () => {
    const { fileObjectId } = await init();
    const done = `${url()}/${fileObjectId}/complete`;
    const early = await w.member.post(done);
    expect(early.statusCode).toBe(409);
    expect(w.jobs.jobs).toHaveLength(0);
    w.signer.put(keyOf(fileObjectId), 1000);
    const r = await w.member.post(done);
    expect(r.statusCode).toBe(202);
    expect(Value.Check(CompleteUploadResponse, r.json())).toBe(true);
    expect(w.jobs.jobs).toEqual([
      expect.objectContaining({
        kind: 'process_upload',
        subjectType: 'upload',
        subjectId: fileObjectId,
        consentAttestationId: w.consents.rows[0]!.id,
      }),
    ]);
    expect((await w.member.post(done)).statusCode).toBe(409);
    expect(w.jobs.jobs).toHaveLength(1);
  });

  it('complete without a stored attestation -> 422 CONSENT_REQUIRED and no job', async () => {
    const { fileObjectId } = await init();
    w.consents.rows.length = 0;
    w.signer.put(keyOf(fileObjectId), 1000);
    const r = await w.member.post(`${url()}/${fileObjectId}/complete`);
    expect(r.statusCode).toBe(422);
    expect(errorOf(r)).toMatchObject({ code: 'VALIDATION_FAILED', reason: 'CONSENT_REQUIRED' });
    expect(w.jobs.jobs).toHaveLength(0);
  });

  it('complete with a stored attestation of an unsupported version or skewed time -> 422 and no job', async () => {
    const a = await init();
    w.signer.put(keyOf(a.fileObjectId), 1000);
    w.consents.rows[0]!.consentVersion = 'old-1';
    const r1 = await w.member.post(`${url()}/${a.fileObjectId}/complete`);
    expect(errorOf(r1).reason).toBe('CONSENT_VERSION_UNSUPPORTED');
    const b = await init();
    w.signer.put(keyOf(b.fileObjectId), 1000);
    const row = w.consents.rows.at(-1)!;
    row.attestedAt = new Date(row.recordedAt.getTime() + 301_000);
    const r2 = await w.member.post(`${url()}/${b.fileObjectId}/complete`);
    expect(r2.statusCode).toBe(422);
    expect(errorOf(r2).reason).toBe('CONSENT_INVALID');
    expect(w.jobs.jobs).toHaveLength(0);
  });

  it('complete: size mismatch 409; another member 403; other org 404', async () => {
    const { fileObjectId } = await init();
    w.signer.put(keyOf(fileObjectId), 999);
    const done = `${url()}/${fileObjectId}/complete`;
    expect((await w.member.post(done)).statusCode).toBe(409);
    expect((await w.viewer.post(done)).statusCode).toBe(403);
    expect(
      (await w.other.post(`/orgs/${w.otherOrg}/uploads/${fileObjectId}/complete`)).statusCode,
    ).toBe(404);
    expect(w.jobs.jobs).toHaveLength(0);
  });

  it('download-url expires in <= 300 s, only after complete, and never cross-org', async () => {
    const { fileObjectId } = await init();
    const dl = `${url()}/${fileObjectId}/download-url`;
    expect((await w.member.get(dl)).statusCode).toBe(409);
    w.signer.put(keyOf(fileObjectId), 1000);
    expect((await w.member.post(`${url()}/${fileObjectId}/complete`)).statusCode).toBe(202);
    const before = Date.now();
    const r = await w.viewer.get(dl);
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const out = r.json<DownloadUrlResponse>();
    expect(Value.Check(DownloadUrlResponse, out)).toBe(true);
    expect(Date.parse(out.download.expiresAt) - before).toBeLessThanOrEqual(300_000 + 1000);
    expect(
      (await w.other.get(`/orgs/${w.otherOrg}/uploads/${fileObjectId}/download-url`)).statusCode,
    ).toBe(404);
  });
});
