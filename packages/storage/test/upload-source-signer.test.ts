import { createHash } from 'node:crypto';
import { describe, expect, it, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { S3UploadSourceSigner, StorageValidationError, loadStorageConfig } from '../src/index.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const UP = '22222222-2222-4222-8222-222222222222';
const KEY = `organizations/${ORG}/uploads/${UP}/source`;
// Dummy media: a few synthetic bytes, never real audio.
const DUMMY = Buffer.from('dummy-media-bytes');
const SHA = createHash('sha256').update(DUMMY).digest('base64');

const config = loadStorageConfig({
  STORAGE_PROVIDER: 'minio',
  STORAGE_ENDPOINT: 'http://127.0.0.1:9',
  STORAGE_BUCKET: 'test-bucket',
  STORAGE_ACCESS_KEY_ID: 'test',
  STORAGE_SECRET_ACCESS_KEY: 'test-only-not-a-secret',
});

describe('S3UploadSourceSigner', () => {
  const s3 = mockClient(S3Client);
  const calls: unknown[] = [];
  const presign = (async (_c: unknown, cmd: { input: unknown }, o: unknown) => {
    calls.push({ input: cmd.input, o });
    return 'https://signed.example.test/x';
  }) as never;
  const now = new Date('2026-10-28T00:00:00Z');
  let signer: S3UploadSourceSigner;
  beforeEach(() => {
    s3.reset();
    calls.length = 0;
    signer = new S3UploadSourceSigner({ config, client: new S3Client({}), presign, now: () => now });
  });

  it('signs a PUT with content-length, type and sha256', async () => {
    const r = await signer.presignPut({
      key: KEY,
      mimeType: 'audio/webm',
      sizeBytes: DUMMY.length,
      checksumSha256Base64: SHA,
      ttlSeconds: 300,
    });
    expect(r.method).toBe('PUT');
    expect(r.headers).toEqual({
      'content-type': 'audio/webm',
      'content-length': String(DUMMY.length),
      'x-amz-checksum-sha256': SHA,
    });
    expect(r.expiresAt.getTime()).toBe(now.getTime() + 300_000);
    const c = calls[0] as { input: Record<string, unknown> };
    expect(c.input).toMatchObject({ Bucket: 'test-bucket', Key: KEY, ChecksumSHA256: SHA });
  });

  it('forces attachment + allowlisted type on GET', async () => {
    await signer.presignGet({ key: KEY, ttlSeconds: 60, contentType: 'text/html' });
    const c = calls[0] as { input: Record<string, unknown> };
    expect(c.input).toMatchObject({
      ResponseContentDisposition: 'attachment',
      ResponseContentType: 'application/octet-stream',
    });
  });

  it('rejects keys that are not upload sources', async () => {
    for (const key of [`organizations/${ORG}/meetings/x/raw`, `../${KEY}`, `org/${ORG}/uploads/${UP}/source`]) {
      await expect(
        signer.presignGet({ key, ttlSeconds: 60, contentType: 'audio/webm' }),
      ).rejects.toBeInstanceOf(StorageValidationError);
    }
  });

  it('heads with checksum mode; null when missing, null checksum for composites', async () => {
    s3.on(HeadObjectCommand).resolvesOnce({ ContentLength: 17, ChecksumSHA256: SHA });
    expect(await signer.head(KEY)).toEqual({ sizeBytes: 17, checksumSha256Base64: SHA });
    expect(s3.commandCalls(HeadObjectCommand)[0]!.args[0].input.ChecksumMode).toBe('ENABLED');
    s3.on(HeadObjectCommand).resolvesOnce({ ContentLength: 17, ChecksumSHA256: `${SHA}-2` });
    expect((await signer.head(KEY))?.checksumSha256Base64).toBeNull();
    s3.on(HeadObjectCommand).rejectsOnce(Object.assign(new Error('nf'), { name: 'NotFound' }));
    expect(await signer.head(KEY)).toBeNull();
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(s3.commandCalls(GetObjectCommand)).toHaveLength(0);
  });
});
