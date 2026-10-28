/** #300 M-1 / L-1: upload init signs within the signer TTL cap and leaves nothing behind when signing or persisting fails. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_PRESIGN_TTL_SECONDS } from '@meetops/storage';
import { UPLOAD_URL_TTL_SECONDS } from '../src/modules/media/application/upload.service.js';
import type { InMemoryFileObjectRepository } from '../src/modules/media/infrastructure/in-memory.js';
import { consent, mediaWorld, SHA_B64, type MediaWorld } from './media-helpers.js';

const body = () => ({
  filename: 'dummy.webm',
  mimeType: 'audio/webm',
  sizeBytes: 1000,
  checksumSha256: SHA_B64,
  consent: consent(),
});

describe('upload init (#300)', () => {
  let w: MediaWorld | undefined;
  afterEach(async () => {
    vi.restoreAllMocks();
    await w?.app.close();
    w = undefined;
  });
  const files = (x: MediaWorld) => (x.media.files as InMemoryFileObjectRepository).rows;

  it('M-1: the upload URL TTL is within the signer cap and is what gets signed', async () => {
    expect(UPLOAD_URL_TTL_SECONDS).toBe(300);
    expect(UPLOAD_URL_TTL_SECONDS).toBeLessThanOrEqual(MAX_PRESIGN_TTL_SECONDS);
    w = await mediaWorld();
    const r = await w.member.post(`/orgs/${w.org}/uploads`, body());
    expect(r.statusCode).toBe(201);
    expect(r.json<{ upload: { url: string } }>().upload.url).toContain('X-Amz-Expires=300');
  });

  it('signer failure: 500 and no file row or consent attestation', async () => {
    w = await mediaWorld();
    vi.spyOn(w.signer, 'presignPut').mockRejectedValue(
      new RangeError('Presign TTL must be an integer'),
    );
    const r = await w.member.post(`/orgs/${w.org}/uploads`, body());
    expect(r.statusCode).toBe(500);
    expect(files(w).size).toBe(0);
    expect(w.consents.rows).toHaveLength(0);
  });

  it('atomic persist failure: 500 and no consent recorded separately', async () => {
    w = await mediaWorld();
    const repo = w.media.files as InMemoryFileObjectRepository & {
      createWithConsent?: (...a: unknown[]) => Promise<unknown>;
    };
    const atomic = vi.fn().mockRejectedValue(new Error('db down'));
    repo.createWithConsent = atomic;
    const create = vi.spyOn(repo, 'create');
    const record = vi.spyOn(w.consents, 'record');
    const r = await w.member.post(`/orgs/${w.org}/uploads`, body());
    expect(r.statusCode).toBe(500);
    expect(atomic).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    expect(files(w).size).toBe(0);
    expect(w.consents.rows).toHaveLength(0);
  });

  it('the in-memory fake signer enforces the same TTL cap as the real one', async () => {
    w = await mediaWorld();
    await expect(
      w.signer.presignPut({
        key: `organizations/${w.org}/uploads/x/source`,
        mimeType: 'audio/webm',
        sizeBytes: 1,
        checksumSha256Base64: SHA_B64,
        ttlSeconds: MAX_PRESIGN_TTL_SECONDS + 1,
      }),
    ).rejects.toThrow(RangeError);
  });
});
