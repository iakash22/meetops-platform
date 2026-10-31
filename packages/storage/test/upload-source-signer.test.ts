import { createHash } from 'node:crypto';
import { describe, expect, it, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  S3SessionChunkStore,
  S3UploadSourceSigner,
  StorageAccessError,
  StorageValidationError,
  loadStorageConfig,
  sourceExtForMime,
} from '../src/index.js';

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
    signer = new S3UploadSourceSigner({
      config,
      client: new S3Client({}),
      presign,
      now: () => now,
    });
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

  it('signs and heads session chunk keys, but never presigns a GET for them', async () => {
    const chunk = `organizations/${ORG}/recording-sessions/${UP}/chunks/00000`;
    const put = await signer.presignPut({
      key: chunk,
      mimeType: 'video/webm',
      sizeBytes: DUMMY.length,
      checksumSha256Base64: SHA,
      ttlSeconds: 300,
    });
    expect(put.method).toBe('PUT');
    s3.on(HeadObjectCommand).resolvesOnce({ ContentLength: DUMMY.length, ChecksumSHA256: SHA });
    expect(await signer.head(chunk)).toEqual({
      sizeBytes: DUMMY.length,
      checksumSha256Base64: SHA,
    });
    await expect(
      signer.presignGet({ key: chunk, ttlSeconds: 60, contentType: 'video/webm' }),
    ).rejects.toBeInstanceOf(StorageValidationError);
    await expect(
      signer.head(`organizations/${ORG}/recording-sessions/not-a-uuid/chunks/00000`),
    ).rejects.toBeInstanceOf(StorageValidationError);
  });

  it('rejects keys that are not upload sources', async () => {
    for (const key of [
      `organizations/${ORG}/meetings/x/raw`,
      `../${KEY}`,
      `org/${ORG}/uploads/${UP}/source`,
    ]) {
      await expect(
        signer.presignGet({ key, ttlSeconds: 60, contentType: 'audio/webm' }),
      ).rejects.toBeInstanceOf(StorageValidationError);
    }
  });

  it('heads with checksum mode; null when missing, null checksum for composites', async () => {
    s3.on(HeadObjectCommand)
      .resolvesOnce({ ContentLength: 17, ChecksumSHA256: SHA })
      .resolvesOnce({ ContentLength: 17, ChecksumSHA256: `${SHA}-2` })
      .rejectsOnce(Object.assign(new Error('nf'), { name: 'NotFound' }));
    expect(await signer.head(KEY)).toEqual({ sizeBytes: 17, checksumSha256Base64: SHA });
    expect(s3.commandCalls(HeadObjectCommand)[0]!.args[0].input.ChecksumMode).toBe('ENABLED');
    expect((await signer.head(KEY))?.checksumSha256Base64).toBeNull();
    expect(await signer.head(KEY)).toBeNull();
    expect(s3.commandCalls(PutObjectCommand)).toHaveLength(0);
    expect(s3.commandCalls(GetObjectCommand)).toHaveLength(0);
  });
});

describe('S3SessionChunkStore / sourceExtForMime', () => {
  const s3 = mockClient(S3Client);
  const chunk = `organizations/${ORG}/recording-sessions/${UP}/chunks/00001`;
  it('reads + deletes only chunks of the bound org and session', async () => {
    s3.reset();
    s3.on(GetObjectCommand).resolves({ Body: Readable.from([DUMMY]) as never });
    const store = new S3SessionChunkStore({ config, client: new S3Client({}) });
    const body = await store.readChunk(ORG, UP, chunk);
    const got: Buffer[] = [];
    for await (const p of body) got.push(Buffer.from(p as Buffer));
    expect(Buffer.concat(got)).toEqual(DUMMY);
    await store.deleteChunk(ORG, UP, chunk);
    expect(s3.commandCalls(DeleteObjectCommand)[0]!.args[0].input.Key).toBe(chunk);
    const otherOrg = '99999999-9999-4999-8999-999999999999';
    await expect(store.readChunk(otherOrg, UP, chunk)).rejects.toBeInstanceOf(StorageAccessError);
    await expect(store.readChunk(ORG, otherOrg, chunk)).rejects.toBeInstanceOf(StorageAccessError);
    await expect(store.deleteChunk(ORG, UP, KEY)).rejects.toBeInstanceOf(StorageAccessError);
  });
  it('maps allowed media mime types to recording source extensions', () => {
    expect(sourceExtForMime('video/webm;codecs=vp9')).toBe('webm');
    expect(sourceExtForMime('audio/mpeg')).toBe('mp3');
    expect(sourceExtForMime('audio/x-wav')).toBe('wav');
    expect(sourceExtForMime('text/html')).toBeNull();
  });
});
