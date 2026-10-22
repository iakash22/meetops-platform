import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { MAX_MEDIA_BYTES } from '@meetops/contracts';
import {
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListPartsCommand,
  S3Client
} from '@aws-sdk/client-s3';
import {
  InMemoryUploadTokenStore,
  RedisUploadTokenStore,
  S3StorageService,
  StorageValidationError,
  isSha256Base64,
  loadStorageConfig,
  type MeetingObjectRef,
  type RedisLikeClient,
  type UploadTokenStore
} from '../src/index.js';

const s3 = mockClient(S3Client);
const client = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'a', secretAccessKey: 's' } });
const config = loadStorageConfig({ STORAGE_BUCKET: 'b', STORAGE_ENDPOINT: 'http://localhost:9000', STORAGE_ACCESS_KEY_ID: 'a', STORAGE_SECRET_ACCESS_KEY: 's' });
const rec: MeetingObjectRef = { orgId: 'o1', meetingId: 'm1', kind: 'recording', objectId: 'r1', ext: 'webm' };
const REC_KEY = 'org/o1/meetings/m1/recordings/r1.webm';
const SUM = 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0='; // sha256('abc')
const OTHER = Buffer.alloc(32, 7).toString('base64');
const MB = 1024 * 1024;
const svc = (o: { uploadTokens?: UploadTokenStore; real?: boolean } = {}) =>
  new S3StorageService({
    config,
    ...(o.real ? {} : { client, presign: vi.fn().mockResolvedValue('https://signed'), presignPost: vi.fn().mockResolvedValue({ url: 'https://p', fields: {} }) }),
    authorize: () => undefined,
    ...(o.uploadTokens ? { uploadTokens: o.uploadTokens } : {})
  });

beforeEach(() => s3.reset());

describe('1. source media cap (1.4 GB, single-sourced from contracts)', () => {
  it('MAX_MEDIA_BYTES is 1_400_000_000 and is the storage default/max', () => {
    expect(MAX_MEDIA_BYTES).toBe(1_400_000_000);
    expect(config.limits.maxObjectBytes).toBe(MAX_MEDIA_BYTES);
    expect(() => loadStorageConfig({ STORAGE_BUCKET: 'b', STORAGE_MAX_OBJECT_BYTES: '2000000000' })).toThrow();
  });
  it('presign PUT/POST and multipart reject sizes above the cap and accept exactly the cap', async () => {
    const s = svc();
    const over = { mimeType: 'video/mp4', sizeBytes: MAX_MEDIA_BYTES + 1, checksumSha256: SUM };
    await expect(s.getPresignedUploadUrl(rec, over)).rejects.toThrow(/sizeBytes out of range/);
    await expect(s.getPresignedUploadPost(rec, over)).rejects.toThrow(/sizeBytes out of range/);
    await expect(s.createMultipartUpload(rec, { ...over, partSizeBytes: 64 * MB })).rejects.toThrow(/sizeBytes out of range/);
    await expect(s.getPresignedUploadUrl(rec, { ...over, sizeBytes: MAX_MEDIA_BYTES })).resolves.toMatchObject({ method: 'PUT' });
  });
});

describe('3. required sha256', () => {
  it('validates base64 sha256 strictly', () => {
    expect(isSha256Base64(SUM)).toBe(true);
    expect(isSha256Base64('a'.repeat(64))).toBe(false); // hex is not base64 sha256
    expect(isSha256Base64(SUM.slice(0, -1))).toBe(false);
    expect(isSha256Base64(Buffer.alloc(31).toString('base64'))).toBe(false);
    expect(isSha256Base64(undefined)).toBe(false);
  });
  it('presign PUT/POST/multipart reject missing or invalid checksumSha256', async () => {
    const s = svc();
    const base = { mimeType: 'audio/webm', sizeBytes: 3 };
    for (const call of [
      (c?: string) => s.getPresignedUploadUrl(rec, { ...base, checksumSha256: c as string }),
      (c?: string) => s.getPresignedUploadPost(rec, { ...base, checksumSha256: c as string }),
      (c?: string) => s.createMultipartUpload(rec, { ...base, partSizeBytes: 3, checksumSha256: c as string })
    ]) {
      await expect(call(undefined)).rejects.toThrow(/checksumSha256 is required/);
      await expect(call('nope')).rejects.toThrow(/Invalid checksumSha256/);
    }
    await expect(s.getPresignedPartUrl(rec, 'u1', 1, 5 * MB, undefined as never)).rejects.toThrow(/partChecksumSha256 is required/);
    await expect(s.getPresignedPartUrl(rec, 'u1', 1, 5 * MB, 'zz')).rejects.toThrow(/Invalid partChecksumSha256/);
    expect(s3.calls()).toHaveLength(0);
  });
  it('real presigned PUT signs checksum, one-time token and If-None-Match as headers', async () => {
    const put = await svc({ real: true }).getPresignedUploadUrl(rec, { mimeType: 'audio/webm', sizeBytes: 3, checksumSha256: SUM });
    const u = new URL(put.url);
    const signed = (u.searchParams.get('X-Amz-SignedHeaders') ?? '').split(';');
    expect(signed).toEqual(expect.arrayContaining(['content-length', 'content-type', 'x-amz-checksum-sha256', 'x-amz-meta-upload-token', 'if-none-match']));
    expect(put.url).not.toContain(put.uploadToken); // not hoisted to the query: client must send the header
    expect(put.headers).toMatchObject({ 'x-amz-checksum-sha256': SUM, 'x-amz-meta-upload-token': put.uploadToken, 'if-none-match': '*' });
    expect(put.uploadToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });
  it('real presigned part URL signs the part checksum', async () => {
    const p = await svc({ real: true }).getPresignedPartUrl(rec, 'u1', 1, 5 * MB, SUM);
    expect((new URL(p.url).searchParams.get('X-Amz-SignedHeaders') ?? '').split(';')).toEqual(expect.arrayContaining(['content-length', 'x-amz-checksum-sha256']));
    expect(p.headers).toEqual({ 'content-length': String(5 * MB), 'x-amz-checksum-sha256': SUM });
  });
  it('presigned POST policy pins checksum and token', async () => {
    const p = await svc({ real: true }).getPresignedUploadPost(rec, { mimeType: 'audio/webm', sizeBytes: 3, checksumSha256: SUM });
    const policy = JSON.parse(Buffer.from(p.fields!.Policy!, 'base64').toString()) as { conditions: unknown[] };
    expect(policy.conditions).toContainEqual(['eq', '$x-amz-checksum-sha256', SUM]);
    expect(policy.conditions).toContainEqual(['eq', '$x-amz-meta-upload-token', p.uploadToken]);
    expect(p.fields).toMatchObject({ 'x-amz-checksum-sha256': SUM, 'x-amz-meta-upload-token': p.uploadToken });
  });
  it('multipart create requests SHA256 checksums and records the declared sha256', async () => {
    s3.on(CreateMultipartUploadCommand).resolves({ UploadId: 'u1' });
    await svc().createMultipartUpload(rec, { mimeType: 'video/mp4', sizeBytes: 10 * MB, partSizeBytes: 5 * MB, checksumSha256: SUM });
    expect(s3.commandCalls(CreateMultipartUploadCommand)[0]!.args[0].input).toMatchObject({ ChecksumAlgorithm: 'SHA256', Metadata: { sha256: SUM } });
  });
  it('session chunk presign requires sha256 hex and signs If-None-Match', async () => {
    s3.on(ListObjectsV2Command).resolves({ Contents: [], IsTruncated: false });
    const presign = vi.fn().mockResolvedValue('https://c');
    const s = new S3StorageService({ config, client, authorize: () => undefined, presign });
    const sess = { orgId: 'o1', meetingId: 'm1', sessionId: 's1' };
    await expect(s.getPresignedSessionChunkUrl(sess, { seq: 0, sizeBytes: 1 } as never, 'audio/webm')).rejects.toThrow(/sha256 is required/);
    await expect(s.getPresignedSessionChunkUrl(sess, { seq: 0, sizeBytes: 1, sha256: SUM }, 'audio/webm')).rejects.toThrow(/Invalid sha256/);
    await s.getPresignedSessionChunkUrl(sess, { seq: 0, sizeBytes: 1, sha256: 'a'.repeat(64) }, 'audio/webm');
    const [, cmd, o] = presign.mock.calls[0]!;
    expect(cmd.input.IfNoneMatch).toBe('*');
    expect([...o.signableHeaders]).toContain('if-none-match');
  });
  it('session verify rejects a stored chunk without a checksum', async () => {
    s3.on(ListObjectsV2Command).resolves({ Contents: [{ Key: 'tmp/session-chunks/org/o1/meetings/m1/sessions/s1/00000.part', Size: 5 }], IsTruncated: false });
    s3.on(HeadObjectCommand).resolves({ ContentLength: 5 });
    s3.on(DeleteObjectCommand).resolves({});
    await expect(svc().verifySessionChunks({ orgId: 'o1', meetingId: 'm1', sessionId: 's1' }, { chunkCount: 1 })).rejects.toThrow(/rejected/);
  });
});

describe('2. single-use presigned uploads', () => {
  const spec = { mimeType: 'audio/webm', sizeBytes: 3, checksumSha256: SUM };
  const headOk = (token: string) => ({ ContentLength: 3, ChecksumSHA256: SUM, Metadata: { 'upload-token': token } });

  it('confirmUpload accepts the token once and rejects reuse', async () => {
    const s = svc();
    const p = await s.getPresignedUploadUrl(rec, spec);
    s3.on(HeadObjectCommand).resolves(headOk(p.uploadToken));
    await expect(s.confirmUpload(rec, p.uploadToken)).resolves.toMatchObject({ sizeBytes: 3, checksumSha256: SUM });
    expect(s3.commandCalls(HeadObjectCommand)[0]!.args[0].input).toMatchObject({ Key: REC_KEY, ChecksumMode: 'ENABLED' });
    await expect(s.confirmUpload(rec, p.uploadToken)).rejects.toThrow(/already used/);
  });
  it('a second presign issues a different token; each is bound to its key', async () => {
    const s = svc();
    const a = await s.getPresignedUploadUrl(rec, spec);
    const b = await s.getPresignedUploadPost(rec, spec);
    expect(a.uploadToken).not.toBe(b.uploadToken);
    await expect(s.confirmUpload({ ...rec, objectId: 'r2' }, a.uploadToken)).rejects.toThrow(StorageValidationError);
    await expect(s.confirmUpload(rec, a.uploadToken)).rejects.toThrow(/already used/); // consumed by the failed attempt
    await expect(s.confirmUpload(rec, 'not-a-token')).rejects.toThrow(/Invalid upload token/);
  });
  it('expired tokens are rejected', async () => {
    let now = 1_000_000;
    const store = new InMemoryUploadTokenStore(() => now);
    const s = svc({ uploadTokens: store });
    const p = await s.getPresignedUploadUrl(rec, spec);
    now += (300 + 3600 + 1) * 1000;
    await expect(s.confirmUpload(rec, p.uploadToken)).rejects.toThrow(/expired/);
  });
  it('mismatching object (checksum, size or token metadata) is deleted and rejected', async () => {
    for (const bad of [{ ChecksumSHA256: OTHER }, { ContentLength: 4 }, { Metadata: { 'upload-token': 'x'.repeat(32) } }, { ChecksumSHA256: undefined }]) {
      s3.reset();
      const s = svc();
      const p = await s.getPresignedUploadUrl(rec, spec);
      s3.on(HeadObjectCommand).resolves({ ...headOk(p.uploadToken), ...bad });
      s3.on(DeleteObjectCommand).resolves({});
      await expect(s.confirmUpload(rec, p.uploadToken)).rejects.toThrow(/does not match/);
      expect(s3.commandCalls(DeleteObjectCommand)[0]!.args[0].input.Key).toBe(REC_KEY);
    }
  });
  it('missing object on confirm is rejected', async () => {
    const s = svc();
    const p = await s.getPresignedUploadUrl(rec, spec);
    s3.on(HeadObjectCommand).rejects(Object.assign(new Error('x'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }));
    await expect(s.confirmUpload(rec, p.uploadToken)).rejects.toThrow(/Upload not found/);
  });
  it('multipart complete: once only, If-None-Match, per-part checksum verified against ListParts', async () => {
    s3.on(CreateMultipartUploadCommand).resolves({ UploadId: 'u1' });
    s3.on(CompleteMultipartUploadCommand).resolves({ ETag: '"done"' });
    s3.on(ListPartsCommand).resolves({ Parts: [{ PartNumber: 1, ETag: 'a', ChecksumSHA256: SUM }] });
    const s = svc();
    const big = { mimeType: 'video/mp4', sizeBytes: 5 * MB, partSizeBytes: 5 * MB, checksumSha256: SUM };
    const mp = await s.createMultipartUpload(rec, big);
    const parts = [{ partNumber: 1, etag: 'a', checksumSha256: SUM }];
    await expect(s.completeMultipartUpload(rec, 'u1', [{ partNumber: 1, etag: 'a' }], mp.uploadToken)).rejects.toThrow(/part checksumSha256 is required/);
    await expect(s.completeMultipartUpload(rec, 'other-upload', parts, mp.uploadToken)).rejects.toThrow(/already used/);

    const mp2 = await s.createMultipartUpload(rec, big);
    await expect(s.completeMultipartUpload(rec, 'u1', [{ ...parts[0]!, checksumSha256: OTHER }], mp2.uploadToken)).rejects.toThrow(/checksum mismatch/);

    const mp3 = await s.createMultipartUpload(rec, big);
    await expect(s.completeMultipartUpload(rec, 'u1', parts, mp3.uploadToken)).resolves.toEqual({ etag: '"done"' });
    const input = s3.commandCalls(CompleteMultipartUploadCommand)[0]!.args[0].input;
    expect(input.IfNoneMatch).toBe('*');
    expect(input.MultipartUpload?.Parts).toEqual([{ PartNumber: 1, ETag: 'a', ChecksumSHA256: SUM }]);
    await expect(s.completeMultipartUpload(rec, 'u1', parts, mp3.uploadToken)).rejects.toThrow(/already used/);
    expect(s3.commandCalls(CompleteMultipartUploadCommand)).toHaveLength(1);
  });
});

describe('UploadTokenStore implementations', () => {
  const rec0 = { key: 'k', checksumSha256: SUM, sizeBytes: 1 };
  it('in-memory: issue is NX, consume is one-shot, entries expire', async () => {
    let now = 0;
    const m = new InMemoryUploadTokenStore(() => now);
    expect(await m.issue('t', rec0, 10)).toBe(true);
    expect(await m.issue('t', rec0, 10)).toBe(false);
    expect(await m.consume('t')).toEqual(rec0);
    expect(await m.consume('t')).toBeNull();
    await m.issue('u', rec0, 10);
    now = 10_000;
    expect(m.size).toBe(0);
    expect(await m.consume('u')).toBeNull();
  });
  it('redis: uses SET EX NX and GETDEL', async () => {
    const kv = new Map<string, string>();
    const set = vi.fn(async (k: string, v: string) => (kv.has(k) ? null : (kv.set(k, v), 'OK')));
    const redis: RedisLikeClient = {
      set,
      getdel: vi.fn(async (k: string) => {
        const v = kv.get(k) ?? null;
        kv.delete(k);
        return v;
      })
    };
    const r = new RedisUploadTokenStore(redis, 'p:');
    expect(await r.issue('t', rec0, 60)).toBe(true);
    expect(set).toHaveBeenCalledWith('p:t', JSON.stringify(rec0), 'EX', 60, 'NX');
    expect(await r.issue('t', rec0, 60)).toBe(false);
    expect(await r.consume('t')).toEqual(rec0);
    expect(await r.consume('t')).toBeNull();
  });
});
