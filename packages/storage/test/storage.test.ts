import { Readable } from 'node:stream';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetBucketAclCommand,
  GetBucketPolicyStatusCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListPartsCommand,
  PutObjectCommand,
  S3Client
} from '@aws-sdk/client-s3';
import {
  S3StorageService,
  StorageAccessError,
  StorageError,
  StorageNotFoundError,
  StorageValidationError,
  assertKeyOwnedBy,
  buildObjectKey,
  loadStorageConfig,
  parseMeetingKey,
  toPresignedUrlDto,
  toPublicFileObject,
  type MeetingObjectRef,
  type StorageConfig
} from '../src/index.js';

const MB = 1024 * 1024;
const config: StorageConfig = loadStorageConfig({
  STORAGE_BUCKET: 'secret-bucket',
  STORAGE_ENDPOINT: 'http://localhost:9000',
  STORAGE_ACCESS_KEY_ID: 'a',
  STORAGE_SECRET_ACCESS_KEY: 's',
  STORAGE_MAX_OBJECT_BYTES: String(500 * MB),
  STORAGE_MAX_PART_BYTES: String(10 * MB),
  STORAGE_MAX_PARTS: '20'
});

const s3 = mockClient(S3Client);
const client = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'a', secretAccessKey: 's' } });
const svc = (extra: Partial<ConstructorParameters<typeof S3StorageService>[0]> = {}) => new S3StorageService({ config, client, ...extra });

const rec: MeetingObjectRef = { orgId: 'o1', meetingId: 'm1', kind: 'recording', objectId: 'r1', ext: 'webm' };
const REC_KEY = 'org/o1/meetings/m1/recordings/r1.webm';
const spec = { mimeType: 'audio/webm', sizeBytes: 3 };

beforeEach(() => s3.reset());

describe('config', () => {
  const base = { STORAGE_BUCKET: 'b', STORAGE_ENDPOINT: 'http://m:9000' };
  it('defaults: minio path-style, TTLs 600/300', () => {
    const c = loadStorageConfig(base);
    expect(c).toMatchObject({ provider: 'minio', forcePathStyle: true, uploadTtlSeconds: 600, downloadTtlSeconds: 300 });
    expect(loadStorageConfig({ STORAGE_PROVIDER: 's3', STORAGE_BUCKET: 'b' }).forcePathStyle).toBe(false);
    expect(loadStorageConfig({ ...base, STORAGE_PROVIDER: 'r2' }).region).toBe('auto');
  });
  it('rejects TTL over 600 and bad input', () => {
    expect(() => loadStorageConfig({ ...base, STORAGE_UPLOAD_TTL_SECONDS: '601' })).toThrow();
    expect(() => loadStorageConfig({ ...base, STORAGE_DOWNLOAD_TTL_SECONDS: '3600' })).toThrow();
    expect(() => loadStorageConfig({ ...base, STORAGE_PROVIDER: 'gcs' })).toThrow();
    expect(() => loadStorageConfig({ STORAGE_ENDPOINT: 'x' })).toThrow(/BUCKET/);
    expect(() => loadStorageConfig({ ...base, STORAGE_FORCE_PATH_STYLE: 'maybe' })).toThrow();
  });
});

describe('keys', () => {
  it('derives keys server-side from ids and kind', () => {
    expect(buildObjectKey(rec)).toBe(REC_KEY);
    expect(buildObjectKey({ orgId: 'o1', meetingId: 'm1', kind: 'normalized', objectId: 'r1' })).toBe('org/o1/meetings/m1/processed/r1/normalized.wav');
    expect(buildObjectKey({ orgId: 'o1', meetingId: 'm1', kind: 'chunk', objectId: 'r1', index: 3 })).toBe(
      'org/o1/meetings/m1/processed/r1/chunks/00003.wav'
    );
    expect(parseMeetingKey(REC_KEY)).toEqual({ orgId: 'o1', meetingId: 'm1', rest: 'recordings/r1.webm' });
  });
  it('rejects traversal, raw paths and missing parts', () => {
    expect(() => buildObjectKey({ ...rec, orgId: '../x' })).toThrow(StorageValidationError);
    expect(() => buildObjectKey({ ...rec, objectId: 'a/b' })).toThrow();
    expect(() => buildObjectKey({ ...rec, ext: 'we/bm' })).toThrow();
    expect(() => buildObjectKey({ orgId: 'o1', meetingId: 'm1', kind: 'chunk', objectId: 'r1' })).toThrow();
    expect(() => buildObjectKey({ ...rec, kind: 'bogus' as never })).toThrow();
  });
  it('ownership check never echoes the key', () => {
    expect(() => assertKeyOwnedBy(REC_KEY, 'o1')).not.toThrow();
    for (const org of ['o2', 'o', '']) {
      try {
        assertKeyOwnedBy(REC_KEY, org);
        expect.fail('should throw');
      } catch (e) {
        expect(e).toBeInstanceOf(StorageAccessError);
        expect((e as Error).message).not.toContain('meetings');
      }
    }
  });
});

describe('S3StorageService', () => {
  it('requires orgId on every op', async () => {
    const s = svc();
    const bad = { ...rec, orgId: undefined } as unknown as MeetingObjectRef;
    await expect(s.headObject(bad)).rejects.toBeInstanceOf(StorageError);
    await expect(s.getPresignedDownloadUrl(bad)).rejects.toBeInstanceOf(StorageError);
    await expect(s.deleteObject(bad)).rejects.toBeInstanceOf(StorageError);
    expect(s3.calls()).toHaveLength(0);
  });

  it('calls the extra authorize hook with the ref', async () => {
    const authorize = vi.fn(() => {
      throw new StorageAccessError();
    });
    await expect(svc({ authorize }).deleteObject(rec)).rejects.toBeInstanceOf(StorageAccessError);
    expect(authorize).toHaveBeenCalledWith(rec);
    expect(s3.calls()).toHaveLength(0);
  });

  it('putObject requires mimeType + sizeBytes matching the body', async () => {
    s3.on(PutObjectCommand).resolves({ ETag: '"e"' });
    const s = svc();
    expect(await s.putObject(rec, Buffer.from('abc'), spec)).toEqual({ etag: '"e"' });
    expect(s3.commandCalls(PutObjectCommand)[0]!.args[0].input).toMatchObject({ Key: REC_KEY, ContentType: 'audio/webm', ContentLength: 3 });
    await expect(s.putObject(rec, Buffer.from('abcd'), spec)).rejects.toThrow(/match/);
    await expect(s.putObject(rec, 'a', { sizeBytes: 1 } as never)).rejects.toThrow(/mimeType is required/);
    await expect(s.putObject(rec, 'a', { mimeType: 'audio/webm' } as never)).rejects.toThrow(/sizeBytes is required/);
    await expect(s.putObject(rec, 'a', { mimeType: 'application/x-sh', sizeBytes: 1 })).rejects.toThrow(/not allowed/);
    await expect(s.putObject(rec, Readable.from([]), { mimeType: 'audio/webm', sizeBytes: 600 * MB })).rejects.toThrow(/range/);
  });

  it('getObject streams and returns sanitized info; 404 and 403 map to NOT_FOUND without the key', async () => {
    s3.on(GetObjectCommand).resolvesOnce({ Body: Readable.from([Buffer.from('hi')]) as never, ContentLength: 2, ContentType: 'audio/wav' });
    const r = await svc().getObject(rec);
    const chunks: Buffer[] = [];
    for await (const c of r.body) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('hi');
    expect(r.info).toEqual({ sizeBytes: 2, mimeType: 'audio/wav' });
    expect(JSON.stringify(r.info)).not.toContain('secret-bucket');

    for (const err of [
      Object.assign(new Error(`NoSuchKey ${REC_KEY}`), { name: 'NoSuchKey' }),
      Object.assign(new Error(`AccessDenied ${REC_KEY}`), { name: 'AccessDenied', $metadata: { httpStatusCode: 403 } })
    ]) {
      s3.reset();
      s3.on(GetObjectCommand).rejects(err);
      const e = await svc().getObject(rec).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(StorageNotFoundError);
      expect((e as StorageError).code).toBe('NOT_FOUND');
      expect((e as Error).message).not.toContain(REC_KEY);
    }
    s3.reset();
    s3.on(GetObjectCommand).rejects(Object.assign(new Error(`boom ${REC_KEY}`), { name: 'InternalError' }));
    const e = await svc().getObject(rec).catch((x: unknown) => x);
    expect((e as StorageError).code).toBe('STORAGE_ERROR');
    expect((e as Error).message).not.toContain(REC_KEY);
  });

  it('headObject returns null on 404/403 and renamed fields otherwise', async () => {
    s3.on(HeadObjectCommand).rejects(Object.assign(new Error('x'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }));
    expect(await svc().headObject(rec)).toBeNull();
    s3.reset();
    s3.on(HeadObjectCommand).resolves({ ContentLength: 9, ContentType: 'audio/webm', ETag: '"t"' });
    expect(await svc().headObject(rec)).toEqual({ sizeBytes: 9, mimeType: 'audio/webm', etag: '"t"' });
  });

  it('deleteObject uses the derived key', async () => {
    s3.on(DeleteObjectCommand).resolves({});
    await svc().deleteObject(rec);
    expect(s3.commandCalls(DeleteObjectCommand)[0]!.args[0].input.Key).toBe(REC_KEY);
  });

  it('presign TTL defaults (PUT/POST 600, GET 300) and rejects >600', async () => {
    const presign = vi.fn().mockResolvedValue('https://signed');
    const presignPost = vi.fn().mockResolvedValue({ url: 'https://post', fields: { key: 'k' } });
    const s = svc({ presign, presignPost });
    await s.getPresignedUploadUrl(rec, spec);
    expect(presign.mock.calls[0]![2]).toMatchObject({ expiresIn: 600 });
    await s.getPresignedDownloadUrl(rec);
    expect(presign.mock.calls[1]![2]).toMatchObject({ expiresIn: 300 });
    const post = await s.getPresignedUploadPost(rec, spec);
    expect(presignPost.mock.calls[0]![1]).toMatchObject({ Expires: 600 });
    expect(post).toMatchObject({ method: 'POST', url: 'https://post', fields: { key: 'k' } });
    await expect(s.getPresignedDownloadUrl(rec, { ttlSeconds: 601 })).rejects.toThrow(RangeError);
    await expect(s.getPresignedUploadUrl(rec, spec, { ttlSeconds: 3600 })).rejects.toThrow(RangeError);
    await expect(s.getPresignedUploadPost(rec, spec, { ttlSeconds: 0 })).rejects.toThrow(RangeError);
  });

  it('presigned POST enforces exact content-length-range and Content-Type', async () => {
    const real = new S3StorageService({ config });
    const p = await real.getPresignedUploadPost(rec, { mimeType: 'Audio/WebM; codecs=opus', sizeBytes: 1234 });
    expect(p.url).toBe('http://localhost:9000/secret-bucket');
    const policy = JSON.parse(Buffer.from(p.fields!.Policy!, 'base64').toString()) as { conditions: unknown[]; expiration: string };
    expect(policy.conditions).toContainEqual(['content-length-range', 1234, 1234]);
    expect(policy.conditions).toContainEqual(['eq', '$Content-Type', 'audio/webm']);
    expect(p.fields!.key).toBe(REC_KEY);
    expect(new Date(policy.expiration).getTime() - Date.now()).toBeLessThanOrEqual(600_000);
  });

  it('presigned PUT signs content-type and content-length; GET is path-style', async () => {
    const real = new S3StorageService({ config });
    const put = await real.getPresignedUploadUrl(rec, spec);
    const signed = decodeURIComponent(new URL(put.url).searchParams.get('X-Amz-SignedHeaders') ?? '');
    expect(signed.split(';')).toEqual(expect.arrayContaining(['content-length', 'content-type', 'host']));
    expect(put.headers).toEqual({ 'content-type': 'audio/webm', 'content-length': '3' });
    const get = await real.getPresignedDownloadUrl(rec, { ttlSeconds: 30 });
    expect(get.url).toMatch(/^http:\/\/localhost:9000\/secret-bucket\/org\/o1\/meetings\/m1\/recordings\/r1\.webm\?/);
    expect(get.url).toContain('X-Amz-Expires=30');
    expect(Object.keys(get)).not.toContain('bucket');
  });

  it('multipart: caps part size and part count', async () => {
    s3.on(CreateMultipartUploadCommand).resolves({ UploadId: 'u1' });
    s3.on(CompleteMultipartUploadCommand).resolves({ ETag: '"done"' });
    s3.on(AbortMultipartUploadCommand).resolves({});
    s3.on(ListPartsCommand)
      .resolvesOnce({ Parts: [{ PartNumber: 1, ETag: 'a' }], IsTruncated: true, NextPartNumberMarker: '1' })
      .resolvesOnce({ Parts: [{ PartNumber: 2, ETag: 'b' }], IsTruncated: false });
    const presign = vi.fn().mockResolvedValue('https://part');
    const s = svc({ presign });
    const big = { mimeType: 'video/mp4', sizeBytes: 100 * MB };
    expect(await s.createMultipartUpload(rec, { ...big, partSizeBytes: 10 * MB })).toEqual({ uploadId: 'u1', partCount: 10, partSizeBytes: 10 * MB });
    await expect(s.createMultipartUpload(rec, { ...big, partSizeBytes: 11 * MB })).rejects.toThrow(/partSizeBytes/);
    await expect(s.createMultipartUpload(rec, { mimeType: 'video/mp4', sizeBytes: 300 * MB, partSizeBytes: 10 * MB })).rejects.toThrow(/Too many parts/);
    await expect(s.createMultipartUpload(rec, { ...big, partSizeBytes: 1 * MB })).rejects.toThrow(/minimum/);

    const p = await s.getPresignedPartUrl(rec, 'u1', 1, 10 * MB);
    expect(p).toMatchObject({ url: 'https://part', method: 'PUT', headers: { 'content-length': String(10 * MB) } });
    expect(presign.mock.calls[0]![2]).toMatchObject({ expiresIn: 600 });
    await expect(s.getPresignedPartUrl(rec, 'u1', 21, MB)).rejects.toThrow(/partNumber/);
    await expect(s.getPresignedPartUrl(rec, 'u1', 1, 11 * MB)).rejects.toThrow(/partSizeBytes/);

    expect(await s.listParts(rec, 'u1')).toEqual([{ partNumber: 1, etag: 'a' }, { partNumber: 2, etag: 'b' }]);
    expect(await s.completeMultipartUpload(rec, 'u1', [{ partNumber: 2, etag: 'b' }, { partNumber: 1, etag: 'a' }])).toEqual({ etag: '"done"' });
    expect(s3.commandCalls(CompleteMultipartUploadCommand)[0]!.args[0].input.MultipartUpload?.Parts?.[0]).toEqual({ PartNumber: 1, ETag: 'a' });
    const tooMany = Array.from({ length: 21 }, (_, i) => ({ partNumber: i + 1, etag: 'x' }));
    await expect(s.completeMultipartUpload(rec, 'u1', tooMany)).rejects.toThrow(/Too many/);
    await expect(s.completeMultipartUpload(rec, 'u1', [])).rejects.toThrow();
    await s.abortMultipartUpload(rec, 'u1');
    expect(s3.commandCalls(AbortMultipartUploadCommand)).toHaveLength(1);
  });

  it('verifyBucketPrivate: private, public, and unsupported providers', async () => {
    s3.on(GetBucketPolicyStatusCommand).rejectsOnce(Object.assign(new Error('x'), { name: 'NoSuchBucketPolicy' }));
    s3.on(GetBucketAclCommand).resolvesOnce({ Grants: [{ Grantee: { Type: 'CanonicalUser', ID: 'me' }, Permission: 'FULL_CONTROL' }] });
    expect((await svc().verifyBucketPrivate()).status).toBe('private');

    s3.reset();
    s3.on(GetBucketPolicyStatusCommand).resolves({ PolicyStatus: { IsPublic: false } });
    s3.on(GetBucketAclCommand).resolves({ Grants: [{ Grantee: { Type: 'Group', URI: 'http://acs.amazonaws.com/groups/global/AllUsers' }, Permission: 'READ' }] });
    expect((await svc().verifyBucketPrivate()).status).toBe('public');

    s3.reset();
    s3.on(GetBucketPolicyStatusCommand).rejects(Object.assign(new Error('x'), { name: 'NotImplemented', $metadata: { httpStatusCode: 501 } }));
    s3.on(GetBucketAclCommand).rejects(Object.assign(new Error('x'), { name: 'NotImplemented', $metadata: { httpStatusCode: 501 } }));
    expect(await svc().verifyBucketPrivate()).toEqual({ status: 'unknown', checks: { policy: 'unsupported', acl: 'unsupported' } });
  });

  it('describeObject returns an internal FileObject; public mappers strip provider/bucket/key', async () => {
    s3.on(HeadObjectCommand).resolves({ ContentLength: 7, ContentType: 'audio/webm', LastModified: new Date('2026-01-01T00:00:00Z') });
    const f = await svc().describeObject(rec, 'f1');
    expect(f).toEqual({
      id: 'f1', organizationId: 'o1', provider: 'minio', bucket: 'secret-bucket', key: REC_KEY,
      mimeType: 'audio/webm', sizeBytes: 7, createdAt: '2026-01-01T00:00:00.000Z'
    });
    const exp = new Date('2026-01-01T00:05:00Z');
    const pub = toPublicFileObject(f!, { url: 'https://x', method: 'GET', expiresAt: exp });
    expect(pub).toEqual({
      id: 'f1', organizationId: 'o1', mimeType: 'audio/webm', sizeBytes: 7, createdAt: '2026-01-01T00:00:00.000Z',
      download: { url: 'https://x', method: 'GET', expiresAt: '2026-01-01T00:05:00.000Z' }
    });
    expect(JSON.stringify(pub)).not.toMatch(/secret-bucket|minio|recordings/);
    expect(toPresignedUrlDto({ url: 'https://p', method: 'POST', expiresAt: exp, fields: { a: 'b' } })).toEqual({
      url: 'https://p', method: 'POST', expiresAt: '2026-01-01T00:05:00.000Z', fields: { a: 'b' }
    });
  });
});
