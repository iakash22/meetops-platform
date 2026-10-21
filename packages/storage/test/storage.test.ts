import { Readable } from 'node:stream';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import {
  S3StorageService,
  StorageAccessError,
  StorageNotFoundError,
  StorageValidationError,
  assertKeyOwnedBy,
  buildMeetingKey,
  contentTypeValidator,
  loadStorageConfig,
  parseMeetingKey,
  sizeValidator,
  type StorageConfig
} from '../src/index.js';

const config: StorageConfig = {
  provider: 'minio',
  endpoint: 'http://localhost:9000',
  region: 'us-east-1',
  bucket: 'b',
  accessKeyId: 'a',
  secretAccessKey: 's',
  forcePathStyle: true,
  presignExpiresInSeconds: 900
};

const s3 = mockClient(S3Client);
const client = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'a', secretAccessKey: 's' } });

function svc(extra: Partial<ConstructorParameters<typeof S3StorageService>[0]> = {}) {
  return new S3StorageService({ config, client, ...extra });
}

beforeEach(() => s3.reset());

describe('loadStorageConfig', () => {
  const base = { STORAGE_BUCKET: 'b', STORAGE_ENDPOINT: 'http://m:9000' };
  it('defaults to minio with forcePathStyle on', () => {
    const c = loadStorageConfig(base);
    expect(c.provider).toBe('minio');
    expect(c.forcePathStyle).toBe(true);
    expect(c.region).toBe('us-east-1');
  });
  it('s3 defaults forcePathStyle off and needs no endpoint', () => {
    const c = loadStorageConfig({ STORAGE_PROVIDER: 's3', STORAGE_BUCKET: 'b' });
    expect(c.forcePathStyle).toBe(false);
    expect(c.endpoint).toBeUndefined();
  });
  it('r2 region defaults to auto and explicit forcePathStyle wins', () => {
    const c = loadStorageConfig({ ...base, STORAGE_PROVIDER: 'r2', STORAGE_FORCE_PATH_STYLE: 'true' });
    expect(c.region).toBe('auto');
    expect(c.forcePathStyle).toBe(true);
  });
  it('rejects bad input', () => {
    expect(() => loadStorageConfig({ ...base, STORAGE_PROVIDER: 'gcs' })).toThrow();
    expect(() => loadStorageConfig({ STORAGE_ENDPOINT: 'x' })).toThrow(/BUCKET/);
    expect(() => loadStorageConfig({ STORAGE_BUCKET: 'b' })).toThrow(/ENDPOINT/);
    expect(() => loadStorageConfig({ ...base, STORAGE_FORCE_PATH_STYLE: 'maybe' })).toThrow();
  });
});

describe('keys', () => {
  it('builds and parses meeting keys', () => {
    const k = buildMeetingKey('org1', 'm1', 'raw', 'audio.webm');
    expect(k).toBe('org/org1/meetings/m1/raw/audio.webm');
    expect(parseMeetingKey(k)).toEqual({ orgId: 'org1', meetingId: 'm1', rest: 'raw/audio.webm' });
    expect(buildMeetingKey('o', 'm')).toBe('org/o/meetings/m/');
  });
  it('rejects traversal and slashes', () => {
    expect(() => buildMeetingKey('../x', 'm')).toThrow();
    expect(() => buildMeetingKey('o', 'm', 'a/b')).toThrow();
    expect(() => buildMeetingKey('o', 'm', '..')).toThrow();
  });
  it('ownership check', () => {
    expect(() => assertKeyOwnedBy('org/o1/meetings/m/x', 'o1')).not.toThrow();
    expect(() => assertKeyOwnedBy('org/o2/meetings/m/x', 'o1')).toThrow(StorageAccessError);
    expect(() => assertKeyOwnedBy('org/o1x/meetings/m/x', 'o1')).toThrow(StorageAccessError);
  });
});

describe('S3StorageService', () => {
  it('putObject sends bucket/key/type/length', async () => {
    s3.on(PutObjectCommand).resolves({ ETag: '"e"' });
    const r = await svc().putObject('org/o/meetings/m/a.wav', Buffer.from('abc'), { contentType: 'audio/wav' });
    expect(r).toEqual({ etag: '"e"' });
    const input = s3.commandCalls(PutObjectCommand)[0]!.args[0].input;
    expect(input).toMatchObject({ Bucket: 'b', Key: 'org/o/meetings/m/a.wav', ContentType: 'audio/wav', ContentLength: 3 });
  });

  it('runs validation hooks', async () => {
    const s = svc({ validators: [contentTypeValidator(['audio/wav']), sizeValidator(2)] });
    await expect(s.putObject('k', Buffer.from('abc'), { contentType: 'audio/wav' })).rejects.toThrow(StorageValidationError);
    await expect(s.putObject('k', 'a', { contentType: 'text/plain' })).rejects.toThrow(/not allowed/);
    await expect(s.getPresignedUploadUrl('k', {})).rejects.toThrow(/required/);
    expect(s3.calls()).toHaveLength(0);
  });

  it('ownership hook blocks foreign keys', async () => {
    const s = svc({ ownershipCheck: (k) => assertKeyOwnedBy(k, 'o1') });
    await expect(s.deleteObject('org/o2/meetings/m/x')).rejects.toThrow(StorageAccessError);
    s3.on(DeleteObjectCommand).resolves({});
    await s.deleteObject('org/o1/meetings/m/x');
    expect(s3.commandCalls(DeleteObjectCommand)).toHaveLength(1);
  });

  it('getObject returns a stream and metadata; maps 404', async () => {
    s3.on(GetObjectCommand, { Key: 'k' }).resolves({
      Body: Readable.from([Buffer.from('hi')]) as never,
      ContentLength: 2,
      ContentType: 'audio/wav',
      ETag: '"x"'
    });
    const r = await svc().getObject('k');
    const chunks: Buffer[] = [];
    for await (const c of r.body) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('hi');
    expect(r.metadata).toMatchObject({ key: 'k', bucket: 'b', size: 2, contentType: 'audio/wav' });

    s3.on(GetObjectCommand, { Key: 'missing' }).rejects(Object.assign(new Error('x'), { name: 'NoSuchKey' }));
    await expect(svc().getObject('missing')).rejects.toThrow(StorageNotFoundError);
  });

  it('headObject returns null on 404', async () => {
    s3.on(HeadObjectCommand).rejects(Object.assign(new Error('nf'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }));
    expect(await svc().headObject('k')).toBeNull();
  });

  it('headObject rethrows other errors', async () => {
    s3.on(HeadObjectCommand).rejects(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
    await expect(svc().headObject('k')).rejects.toThrow('denied');
  });

  it('presigns upload and download URLs', async () => {
    const presign = vi.fn().mockResolvedValue('https://signed');
    const s = svc({ presign });
    const up = await s.getPresignedUploadUrl('k', { contentType: 'audio/wav', expiresInSeconds: 60 });
    expect(up).toMatchObject({ url: 'https://signed', method: 'PUT', headers: { 'content-type': 'audio/wav' } });
    expect(presign.mock.calls[0]![1]).toBeInstanceOf(PutObjectCommand);
    expect(presign.mock.calls[0]![2]).toEqual({ expiresIn: 60 });
    const down = await s.getPresignedDownloadUrl('k');
    expect(down.method).toBe('GET');
    expect(presign.mock.calls[1]![2]).toEqual({ expiresIn: 900 });
    expect(down.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('real presigner yields a path-style minio URL', async () => {
    const real = new S3StorageService({ config });
    const u = await real.getPresignedDownloadUrl('org/o/meetings/m/a.wav', 30);
    expect(u.url).toMatch(/^http:\/\/localhost:9000\/b\/org\/o\/meetings\/m\/a\.wav\?/);
    expect(u.url).toContain('X-Amz-Expires=30');
  });

  it('multipart lifecycle', async () => {
    s3.on(CreateMultipartUploadCommand).resolves({ UploadId: 'u1' });
    s3.on(CompleteMultipartUploadCommand).resolves({ ETag: '"done"' });
    s3.on(AbortMultipartUploadCommand).resolves({});
    s3.on(ListPartsCommand)
      .resolvesOnce({ Parts: [{ PartNumber: 1, ETag: 'a' }], IsTruncated: true, NextPartNumberMarker: '1' })
      .resolvesOnce({ Parts: [{ PartNumber: 2, ETag: 'b' }], IsTruncated: false });
    const presign = vi.fn().mockResolvedValue('https://part');
    const s = svc({ presign });
    const mp = await s.createMultipartUpload('k', { contentType: 'audio/wav' });
    expect(mp).toEqual({ key: 'k', uploadId: 'u1' });
    const p = await s.getPresignedPartUrl('k', 'u1', 1);
    expect(p.url).toBe('https://part');
    await expect(s.getPresignedPartUrl('k', 'u1', 0)).rejects.toThrow(StorageValidationError);
    expect(await s.listParts('k', 'u1')).toEqual([{ partNumber: 1, etag: 'a' }, { partNumber: 2, etag: 'b' }]);
    const done = await s.completeMultipartUpload('k', 'u1', [{ partNumber: 2, etag: 'b' }, { partNumber: 1, etag: 'a' }]);
    expect(done).toEqual({ etag: '"done"' });
    expect(s3.commandCalls(CompleteMultipartUploadCommand)[0]!.args[0].input.MultipartUpload?.Parts).toEqual([
      { PartNumber: 1, ETag: 'a' },
      { PartNumber: 2, ETag: 'b' }
    ]);
    await expect(s.completeMultipartUpload('k', 'u1', [])).rejects.toThrow();
    await s.abortMultipartUpload('k', 'u1');
    expect(s3.commandCalls(AbortMultipartUploadCommand)).toHaveLength(1);
  });
});
