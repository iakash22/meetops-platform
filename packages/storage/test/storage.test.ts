import { Readable } from 'node:stream';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { ALLOWED_MEDIA_MIME_TYPES, MAX_CHUNK_BYTES, MAX_MEDIA_BYTES } from '@meetops/contracts';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetBucketAclCommand,
  GetBucketPolicyStatusCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
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
  organizationPrefix,
  orgPrefix,
  refOrganizationId,
  toPresignedUrlDto,
  toSignedPutUpload,
  SESSION_CHUNK_PREFIX,
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
const svc = (extra: Partial<ConstructorParameters<typeof S3StorageService>[0]> = {}) => new S3StorageService({ config, client, authorize: () => undefined, ...extra });

const rec: MeetingObjectRef = { organizationId: 'o1', meetingId: 'm1', kind: 'recording', objectId: 'r1', ext: 'webm' };
const REC_KEY = 'organizations/o1/meetings/m1/recordings/r1.webm';
const spec = { mimeType: 'audio/webm', sizeBytes: 3 };
/** base64 sha256 of 'abc' */
const SUM = 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=';
const pspec = { ...spec, checksumSha256: SUM };

beforeEach(() => s3.reset());

describe('config', () => {
  const base = { STORAGE_BUCKET: 'b', STORAGE_ENDPOINT: 'http://m:9000' };
  it('defaults: minio path-style, TTLs 300/300', () => {
    const c = loadStorageConfig(base);
    expect(c).toMatchObject({ provider: 'minio', forcePathStyle: true, uploadTtlSeconds: 300, downloadTtlSeconds: 300 });
    expect(loadStorageConfig({ STORAGE_PROVIDER: 's3', STORAGE_BUCKET: 'b' }).forcePathStyle).toBe(false);
    expect(loadStorageConfig({ ...base, STORAGE_PROVIDER: 'r2' }).region).toBe('auto');
  });
  it('uses contracts v0.2 limits by default', () => {
    const c = loadStorageConfig(base);
    expect(c.limits.maxObjectBytes).toBe(MAX_MEDIA_BYTES);
    expect(c.limits.maxPartBytes).toBe(MAX_CHUNK_BYTES);
    expect(c.limits.allowedMimeTypes).toEqual(ALLOWED_MEDIA_MIME_TYPES);
    expect(() => loadStorageConfig({ ...base, STORAGE_MAX_OBJECT_BYTES: String(MAX_MEDIA_BYTES + 1) })).toThrow();
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
    expect(buildObjectKey({ organizationId: 'o1', meetingId: 'm1', kind: 'normalized', objectId: 'r1' })).toBe('organizations/o1/meetings/m1/processed/r1/normalized.wav');
    expect(buildObjectKey({ organizationId: 'o1', meetingId: 'm1', kind: 'chunk', objectId: 'r1', index: 3 })).toBe(
      'organizations/o1/meetings/m1/processed/r1/chunks/00003.wav'
    );
    expect(parseMeetingKey(REC_KEY)).toEqual({ organizationId: 'o1', orgId: 'o1', meetingId: 'm1', rest: 'recordings/r1.webm', legacy: false });
  });
  it('writers use organizations/{organizationId}/; readers also accept legacy org/{organizationId}/', () => {
    expect(organizationPrefix('o1')).toBe('organizations/o1/');
    expect(parseMeetingKey('org/o1/meetings/m1/recordings/r1.webm')).toEqual({ organizationId: 'o1', orgId: 'o1', meetingId: 'm1', rest: 'recordings/r1.webm', legacy: true });
    expect(() => assertKeyOwnedBy('org/o1/meetings/m1/recordings/r1.webm', 'o1', 'm1')).not.toThrow();
    expect(() => assertKeyOwnedBy(REC_KEY, 'o1', 'm1')).not.toThrow();
  });
  it('rejects traversal, raw paths and missing parts', () => {
    expect(() => buildObjectKey({ ...rec, organizationId: '../x' })).toThrow(StorageValidationError);
    expect(() => buildObjectKey({ ...rec, objectId: 'a/b' })).toThrow();
    expect(() => buildObjectKey({ ...rec, ext: 'we/bm' })).toThrow();
    expect(() => buildObjectKey({ organizationId: 'o1', meetingId: 'm1', kind: 'chunk', objectId: 'r1' })).toThrow();
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

describe('keys: ADR-010 organizationId naming (compat)', () => {
  const recNew: MeetingObjectRef = { organizationId: 'o1', meetingId: 'm1', kind: 'recording', objectId: 'r1', ext: 'webm' };
  it('organizationId refs produce the exact same key string as legacy orgId refs', () => {
    expect(buildObjectKey(recNew)).toBe(REC_KEY);
    expect(buildObjectKey(recNew)).toBe(buildObjectKey(rec));
    for (const kind of ['recording', 'normalized', 'chunk', 'session_chunk', 'transcript', 'export', 'attachment'] as const) {
      const base = { meetingId: 'm1', kind, objectId: 'x1', ext: 'json', index: 2 };
      expect(buildObjectKey({ ...base, organizationId: 'o9' })).toBe(buildObjectKey({ ...base, orgId: 'o9' }));
    }
  });
  it('organizationPrefix emits organizations/{id}/ (ADR-010 Phase A); orgPrefix is a deprecated alias', () => {
    expect(organizationPrefix('o1')).toBe('organizations/o1/');
    expect(orgPrefix).toBe(organizationPrefix);
    expect(() => organizationPrefix('../x')).toThrow(StorageValidationError);
  });
  it('pre-ADR-010 keys (recording and session chunk) stay readable and owned', () => {
    const sessionKey = `${SESSION_CHUNK_PREFIX}org/o1/meetings/m1/sessions/s1/00007.part`;
    expect(() => assertKeyOwnedBy('org/o1/meetings/m1/recordings/r1.webm', 'o1', 'm1')).not.toThrow();
    expect(() => assertKeyOwnedBy('org/o1/meetings/m1/recordings/r1.webm', 'o2', 'm1')).toThrow(StorageAccessError);
    expect(() => assertKeyOwnedBy(sessionKey, 'o1', 'm1')).not.toThrow();
    expect(() => assertKeyOwnedBy(sessionKey, 'o2')).toThrow(StorageAccessError);
    expect(parseMeetingKey(sessionKey)?.organizationId).toBe('o1');
  });
  it('refOrganizationId rejects conflicting or missing ids', () => {
    expect(refOrganizationId({ organizationId: 'o1' })).toBe('o1');
    expect(refOrganizationId({ orgId: 'o1' })).toBe('o1');
    expect(refOrganizationId({ organizationId: 'o1', orgId: 'o1' })).toBe('o1');
    expect(() => refOrganizationId({ organizationId: 'o1', orgId: 'o2' })).toThrow(StorageValidationError);
    expect(() => refOrganizationId({})).toThrow(StorageValidationError);
    expect(() => buildObjectKey({ ...recNew, orgId: 'o2' })).toThrow(StorageValidationError);
  });
  it('service passes authorize a ref carrying both names', async () => {
    const seen: MeetingObjectRef[] = [];
    s3.on(HeadObjectCommand).resolves({ ContentLength: 3, ContentType: 'audio/webm' });
    await svc({ authorize: (r) => void seen.push(r) }).headObject(recNew);
    expect(seen[0]).toMatchObject({ organizationId: 'o1', orgId: 'o1' });
  });
});

describe('S3StorageService', () => {
  it('requires organizationId on every op', async () => {
    const s = svc();
    const bad = { ...rec, organizationId: undefined } as unknown as MeetingObjectRef;
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
    expect(authorize).toHaveBeenCalledWith({ ...rec, organizationId: 'o1', orgId: 'o1' });
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
    await expect(s.putObject(rec, 'a', { mimeType: 'audio/webm; charset=evil', sizeBytes: 1 })).rejects.toThrow(/not allowed/);
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

  it('presign TTL defaults (PUT/POST 300, GET 300) and rejects >600', async () => {
    const presign = vi.fn().mockResolvedValue('https://signed');
    const presignPost = vi.fn().mockResolvedValue({ url: 'https://post', fields: { key: 'k' } });
    const s = svc({ presign, presignPost });
    await s.getPresignedUploadUrl(rec, pspec);
    expect(presign.mock.calls[0]![2]).toMatchObject({ expiresIn: 300 });
    await s.getPresignedDownloadUrl(rec);
    expect(presign.mock.calls[1]![2]).toMatchObject({ expiresIn: 300 });
    const post = await s.getPresignedUploadPost(rec, pspec);
    expect(presignPost.mock.calls[0]![1]).toMatchObject({ Expires: 300 });
    expect(post).toMatchObject({ method: 'POST', url: 'https://post', fields: { key: 'k' } });
    await expect(s.getPresignedDownloadUrl(rec, { ttlSeconds: 601 })).rejects.toThrow(RangeError);
    await expect(s.getPresignedUploadUrl(rec, pspec, { ttlSeconds: 3600 })).rejects.toThrow(RangeError);
    await expect(s.getPresignedUploadPost(rec, pspec, { ttlSeconds: 0 })).rejects.toThrow(RangeError);
  });

  it('presigned POST enforces exact content-length-range and Content-Type', async () => {
    const real = new S3StorageService({ config, authorize: () => undefined });
    const p = await real.getPresignedUploadPost(rec, { mimeType: 'audio/webm;codecs=opus', sizeBytes: 1234, checksumSha256: SUM });
    expect(p.url).toBe('http://localhost:9000/secret-bucket');
    const policy = JSON.parse(Buffer.from(p.fields!.Policy!, 'base64').toString()) as { conditions: unknown[]; expiration: string };
    expect(policy.conditions).toContainEqual(['content-length-range', 1234, 1234]);
    expect(policy.conditions).toContainEqual(['eq', '$Content-Type', 'audio/webm']);
    expect(p.fields!.key).toBe(REC_KEY);
    expect(new Date(policy.expiration).getTime() - Date.now()).toBeLessThanOrEqual(600_000);
  });

  it('presigned PUT signs content-type and content-length; GET is path-style', async () => {
    const real = new S3StorageService({ config, authorize: () => undefined });
    const put = await real.getPresignedUploadUrl(rec, pspec);
    const signed = decodeURIComponent(new URL(put.url).searchParams.get('X-Amz-SignedHeaders') ?? '');
    expect(signed.split(';')).toEqual(expect.arrayContaining(['content-length', 'content-type', 'host']));
    expect(put.headers).toEqual({
      'content-type': 'audio/webm',
      'content-length': '3',
      'x-amz-checksum-sha256': SUM,
      'x-amz-meta-upload-token': put.uploadToken,
      'if-none-match': '*'
    });
    const get = await real.getPresignedDownloadUrl(rec, { ttlSeconds: 30 });
    expect(get.url).toMatch(/^http:\/\/localhost:9000\/secret-bucket\/organizations\/o1\/meetings\/m1\/recordings\/r1\.webm\?/);
    expect(get.url).toContain('X-Amz-Expires=30');
    expect(Object.keys(get)).not.toContain('bucket');
  });

  it('multipart: caps part size and part count', async () => {
    s3.on(CreateMultipartUploadCommand).resolves({ UploadId: 'u1' });
    s3.on(CompleteMultipartUploadCommand).resolves({ ETag: '"done"' });
    s3.on(AbortMultipartUploadCommand).resolves({});
    s3.on(ListPartsCommand)
      .resolvesOnce({ Parts: [{ PartNumber: 1, ETag: 'a', ChecksumSHA256: SUM }], IsTruncated: true, NextPartNumberMarker: '1' })
      .resolvesOnce({ Parts: [{ PartNumber: 2, ETag: 'b', ChecksumSHA256: SUM }], IsTruncated: false });
    const presign = vi.fn().mockResolvedValue('https://part');
    const s = svc({ presign });
    const big = { mimeType: 'video/mp4', sizeBytes: 100 * MB, checksumSha256: SUM };
    const mp = await s.createMultipartUpload(rec, { ...big, partSizeBytes: 10 * MB });
    expect(mp).toEqual({ uploadId: 'u1', partCount: 10, partSizeBytes: 10 * MB, uploadToken: expect.stringMatching(/^[A-Za-z0-9_-]{32}$/) });
    await expect(s.createMultipartUpload(rec, { ...big, partSizeBytes: 11 * MB })).rejects.toThrow(/partSizeBytes/);
    await expect(s.createMultipartUpload(rec, { mimeType: 'video/mp4', sizeBytes: 300 * MB, checksumSha256: SUM, partSizeBytes: 10 * MB })).rejects.toThrow(/Too many parts/);
    await expect(s.createMultipartUpload(rec, { ...big, partSizeBytes: 1 * MB })).rejects.toThrow(/minimum/);

    const p = await s.getPresignedPartUrl(rec, 'u1', 1, 10 * MB, SUM);
    expect(p).toMatchObject({ url: 'https://part', method: 'PUT', headers: { 'content-length': String(10 * MB), 'x-amz-checksum-sha256': SUM } });
    expect(presign.mock.calls[0]![2]).toMatchObject({ expiresIn: 300 });
    await expect(s.getPresignedPartUrl(rec, 'u1', 21, MB, SUM)).rejects.toThrow(/partNumber/);
    await expect(s.getPresignedPartUrl(rec, 'u1', 1, 11 * MB, SUM)).rejects.toThrow(/partSizeBytes/);

    expect(await s.listParts(rec, 'u1')).toEqual([{ partNumber: 1, etag: 'a', checksumSha256: SUM }, { partNumber: 2, etag: 'b', checksumSha256: SUM }]);
    s3.on(ListPartsCommand).resolves({ Parts: [{ PartNumber: 1, ETag: 'a', ChecksumSHA256: SUM }, { PartNumber: 2, ETag: 'b', ChecksumSHA256: SUM }] });
    const parts = [{ partNumber: 2, etag: 'b', checksumSha256: SUM }, { partNumber: 1, etag: 'a', checksumSha256: SUM }];
    expect(await s.completeMultipartUpload(rec, 'u1', parts, mp.uploadToken)).toEqual({ etag: '"done"' });
    expect(s3.commandCalls(CompleteMultipartUploadCommand)[0]!.args[0].input.MultipartUpload?.Parts?.[0]).toEqual({ PartNumber: 1, ETag: 'a', ChecksumSHA256: SUM });
    const tooMany = Array.from({ length: 21 }, (_, i) => ({ partNumber: i + 1, etag: 'x', checksumSha256: SUM }));
    await expect(s.completeMultipartUpload(rec, 'u1', tooMany, mp.uploadToken)).rejects.toThrow(/Too many/);
    await expect(s.completeMultipartUpload(rec, 'u1', [], mp.uploadToken)).rejects.toThrow();
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

  it('authorize hook is required and always called', async () => {
    expect(() => new S3StorageService({ config, client } as never)).toThrow(/authorize/);
    const authorize = vi.fn();
    s3.on(DeleteObjectCommand).resolves({});
    await svc({ authorize }).deleteObject(rec);
    expect(authorize).toHaveBeenCalledWith({ ...rec, organizationId: 'o1', orgId: 'o1' });
  });

  describe('recording-session chunks (flat tmp prefix)', () => {
    const sess = { organizationId: 'o1', meetingId: 'm1', sessionId: 's1' };
    const key = (seq: number) => `tmp/session-chunks/organizations/o1/meetings/m1/sessions/s1/${String(seq).padStart(5, '0')}.part`;
    const sha = 'a'.repeat(64);
    const shaB64 = Buffer.from(sha, 'hex').toString('base64');
    const listed = (entries: Array<[string, number]>) => ({ Contents: entries.map(([Key, Size]) => ({ Key, Size })), IsTruncated: false });

    it('keys and ownership accept the flat prefix with org+meeting validation', () => {
      expect(SESSION_CHUNK_PREFIX).toBe('tmp/session-chunks/');
      expect(buildObjectKey({ organizationId: 'o1', meetingId: 'm1', kind: 'session_chunk', objectId: 's1', index: 7 })).toBe(key(7));
      expect(() => assertKeyOwnedBy(key(7), 'o1')).not.toThrow();
      expect(() => assertKeyOwnedBy(key(7), 'o1', 'm1')).not.toThrow();
      expect(() => assertKeyOwnedBy(key(7), 'o2')).toThrow(StorageAccessError);
      expect(() => assertKeyOwnedBy(key(7), 'o1', 'm2')).toThrow(StorageAccessError);
      expect(() => assertKeyOwnedBy('tmp/session-chunks/organizations/o1/meetings/m1/other/x.part', 'o1')).toThrow(StorageAccessError);
      expect(() => assertKeyOwnedBy('tmp/session-chunks/organizations/o1/meetings/../x/sessions/s1/00001.part', 'o1')).toThrow(StorageAccessError);
      expect(() => assertKeyOwnedBy('tmp/other/organizations/o1/meetings/m1/sessions/s1/00001.part', 'o1')).toThrow(StorageAccessError);
      expect(() => assertKeyOwnedBy(REC_KEY, 'o1', 'm2')).toThrow(StorageAccessError);
      expect(parseMeetingKey(key(1))).toEqual({ organizationId: 'o1', orgId: 'o1', meetingId: 'm1', rest: 'sessions/s1/00001.part', legacy: false });
    });

    it('presigns a PUT signing content-length, content-type and checksum; TTL <= 300', async () => {
      s3.on(ListObjectsV2Command).resolves(listed([]));
      const presign = vi.fn().mockResolvedValue('https://chunk');
      const s = svc({ presign });
      const p = await s.getPresignedSessionChunkUrl(sess, { seq: 7, sizeBytes: 1000, sha256: sha }, 'audio/webm;codecs=opus');
      expect(p.headers).toEqual({ 'content-type': 'audio/webm', 'content-length': '1000', 'x-amz-checksum-sha256': shaB64, 'if-none-match': '*' });
      const [, cmd, o] = presign.mock.calls[0]!;
      expect(cmd.input).toMatchObject({ Key: key(7), ContentLength: 1000, ChecksumSHA256: shaB64 });
      expect(o.expiresIn).toBe(300);
      expect([...o.signableHeaders]).toEqual(expect.arrayContaining(['content-length', 'content-type', 'x-amz-checksum-sha256']));
      expect(toSignedPutUpload(p)).toMatchObject({ method: 'PUT', headers: { 'content-length': '1000' } });
      expect(s3.commandCalls(ListObjectsV2Command)[0]!.args[0].input.Prefix).toBe('tmp/session-chunks/organizations/o1/meetings/m1/sessions/s1/');
      await expect(s.getPresignedSessionChunkUrl(sess, { seq: 0, sizeBytes: 1, sha256: sha }, 'audio/webm', { ttlSeconds: 301 })).rejects.toThrow(RangeError);
      await expect(s.getPresignedSessionChunkUrl(sess, { seq: 10000, sizeBytes: 1, sha256: sha }, 'audio/webm')).rejects.toThrow(/seq/);
      await expect(s.getPresignedSessionChunkUrl(sess, { seq: 0, sizeBytes: MAX_CHUNK_BYTES + 1, sha256: sha }, 'audio/webm')).rejects.toThrow(/sizeBytes/);
      await expect(s.getPresignedSessionChunkUrl({ ...sess, organizationId: '' }, { seq: 0, sizeBytes: 1, sha256: sha }, 'audio/webm')).rejects.toBeInstanceOf(StorageError);
    });

    it('refuses already-uploaded seq and enforces the running total before issuing', async () => {
      const small = new S3StorageService({
        config: { ...config, limits: { ...config.limits, maxObjectBytes: 100 } },
        client,
        authorize: () => undefined,
        presign: vi.fn().mockResolvedValue('https://x')
      });
      s3.on(ListObjectsV2Command).resolves(listed([[key(0), 60], [key(1), 30]]));
      await expect(small.getPresignedSessionChunkUrl(sess, { seq: 1, sizeBytes: 5, sha256: sha }, 'audio/webm')).rejects.toThrow(/already/);
      await expect(small.getPresignedSessionChunkUrl(sess, { seq: 2, sizeBytes: 11, sha256: sha }, 'audio/webm')).rejects.toThrow(/maximum size/);
      await expect(small.getPresignedSessionChunkUrl(sess, { seq: 2, sizeBytes: 10, sha256: sha }, 'audio/webm')).resolves.toMatchObject({ method: 'PUT' });
    });

    it('verify on complete: happy path with manifest', async () => {
      s3.on(ListObjectsV2Command).resolves(listed([[key(0), 10], [key(1), 10]]));
      s3.on(HeadObjectCommand).resolves({ ContentLength: 10, ChecksumSHA256: shaB64 });
      const r = await svc().verifySessionChunks(sess, { chunkCount: 2, chunks: [{ seq: 0, sha256: sha, sizeBytes: 10 }, { seq: 1, sha256: sha }] });
      expect(r).toEqual({ totalBytes: 20, chunkSizes: [10, 10] });
      expect(s3.commandCalls(HeadObjectCommand)[0]!.args[0].input.ChecksumMode).toBe('ENABLED');
      expect(s3.commandCalls(DeleteObjectCommand)).toHaveLength(0);
    });

    it('verify deletes an oversized/mismatched chunk immediately and then all chunks', async () => {
      s3.on(ListObjectsV2Command).resolves(listed([[key(0), 10], [key(1), 10]]));
      s3.on(HeadObjectCommand, { Key: key(0) }).resolves({ ContentLength: 10, ChecksumSHA256: shaB64 });
      s3.on(HeadObjectCommand, { Key: key(1) }).resolves({ ContentLength: MAX_CHUNK_BYTES + 1 });
      s3.on(DeleteObjectCommand).resolves({});
      await expect(svc().verifySessionChunks(sess, { chunkCount: 2 })).rejects.toThrow(/seq 1 rejected/);
      const deleted = s3.commandCalls(DeleteObjectCommand).map((c) => c.args[0].input.Key);
      expect(deleted[0]).toBe(key(1));
      expect(new Set(deleted)).toEqual(new Set([key(0), key(1)]));

      s3.reset();
      s3.on(ListObjectsV2Command).resolves(listed([[key(0), 10]]));
      s3.on(HeadObjectCommand).resolves({ ContentLength: 10, ChecksumSHA256: Buffer.from('b'.repeat(64), 'hex').toString('base64') });
      s3.on(DeleteObjectCommand).resolves({});
      await expect(svc().verifySessionChunks(sess, { chunkCount: 1, chunks: [{ seq: 0, sha256: sha }] })).rejects.toThrow(/rejected/);
      expect(s3.commandCalls(DeleteObjectCommand).map((c) => c.args[0].input.Key)).toContain(key(0));
    });

    it('verify fails (and deletes all) on gaps, extras, or bad manifests', async () => {
      s3.on(ListObjectsV2Command).resolves(listed([[key(0), 10], [key(2), 10]]));
      s3.on(HeadObjectCommand, { Key: key(0) }).resolves({ ContentLength: 10 });
      s3.on(DeleteObjectCommand).resolves({});
      await expect(svc().verifySessionChunks(sess, { chunkCount: 2 })).rejects.toThrow(/Unexpected/);
      expect(s3.commandCalls(DeleteObjectCommand)).toHaveLength(2);

      s3.reset();
      s3.on(ListObjectsV2Command).resolves(listed([[key(0), 10]]));
      s3.on(HeadObjectCommand, { Key: key(0) }).resolves({ ContentLength: 10, ChecksumSHA256: shaB64 });
      s3.on(HeadObjectCommand, { Key: key(1) }).rejects(Object.assign(new Error('x'), { name: 'NotFound' }));
      s3.on(DeleteObjectCommand).resolves({});
      await expect(svc().verifySessionChunks(sess, { chunkCount: 2 })).rejects.toThrow(/Missing chunk/);
      expect(s3.commandCalls(DeleteObjectCommand).map((c) => c.args[0].input.Key)).toEqual([key(0)]);

      await expect(svc().verifySessionChunks(sess, { chunkCount: 2, chunks: [{ seq: 0, sha256: sha }, { seq: 0, sha256: sha }] })).rejects.toThrow(/manifest/);
    });

    it('abortSession deletes every stored chunk', async () => {
      s3.on(ListObjectsV2Command).resolves(listed([[key(0), 1], [key(1), 1], [key(5), 1]]));
      s3.on(DeleteObjectCommand).resolves({});
      expect(await svc().abortSession(sess)).toEqual({ deleted: 3 });
      expect(s3.commandCalls(DeleteObjectCommand).map((c) => c.args[0].input.Key)).toEqual([key(0), key(1), key(5)]);
    });
  });
});
