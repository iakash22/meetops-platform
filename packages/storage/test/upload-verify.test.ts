import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { mockClient } from 'aws-sdk-client-mock';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  ListPartsCommand,
  S3Client
} from '@aws-sdk/client-s3';
import { S3StorageService, StorageValidationError, loadStorageConfig, type MeetingObjectRef } from '../src/index.js';

const s3 = mockClient(S3Client);
const client = new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'a', secretAccessKey: 's' } });
const config = loadStorageConfig({ STORAGE_BUCKET: 'b', STORAGE_ENDPOINT: 'http://localhost:9000', STORAGE_ACCESS_KEY_ID: 'a', STORAGE_SECRET_ACCESS_KEY: 's' });
const rec: MeetingObjectRef = { organizationId: 'o1', meetingId: 'm1', kind: 'recording', objectId: 'r1', ext: 'webm' };
const REC_KEY = 'organizations/o1/meetings/m1/recordings/r1.webm';
const SUM = 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0='; // sha256('abc')
const HEX = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const MB = 1024 * 1024;
const svc = () =>
  new S3StorageService({ config, client, presign: vi.fn().mockResolvedValue('https://signed'), authorize: () => undefined });
const spec = { mimeType: 'audio/webm', sizeBytes: 3, checksumSha256: SUM };
const body = (s: string) => Readable.from([Buffer.from(s)]) as never;

beforeEach(() => s3.reset());

describe('verifyUpload (single-part)', () => {
  it('returns {verified:true, sha256} and is idempotent across retries', async () => {
    const s = svc();
    const p = await s.getPresignedUploadUrl(rec, spec);
    s3.on(HeadObjectCommand).resolves({ ContentLength: 3, ChecksumSHA256: SUM, Metadata: { 'upload-token': p.uploadToken } });
    const first = await s.verifyUpload(rec, p.uploadToken);
    expect(first).toEqual({ verified: true, sha256: HEX, checksumSha256: HEX, checksumSha256Base64: SUM, sizeBytes: 3 });
    await expect(s.verifyUpload(rec, p.uploadToken)).resolves.toEqual(first);
  });
  it('a retry with a different token than the stored object is rejected', async () => {
    const s = svc();
    const p = await s.getPresignedUploadUrl(rec, spec);
    s3.on(HeadObjectCommand).resolves({ ContentLength: 3, ChecksumSHA256: SUM, Metadata: { 'upload-token': p.uploadToken } });
    await s.verifyUpload(rec, p.uploadToken);
    const other = await s.getPresignedUploadUrl(rec, spec);
    await s.verifyUpload(rec, other.uploadToken).catch(() => undefined); // consumes `other` (mismatch -> delete)
    await expect(s.verifyUpload(rec, other.uploadToken)).rejects.toThrow(StorageValidationError);
  });
  it('mismatch deletes the object and a retry then fails (never verified)', async () => {
    const s = svc();
    const p = await s.getPresignedUploadUrl(rec, spec);
    s3.on(HeadObjectCommand)
      .resolvesOnce({ ContentLength: 4, ChecksumSHA256: SUM, Metadata: { 'upload-token': p.uploadToken } })
      .rejects(Object.assign(new Error('x'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } }));
    s3.on(DeleteObjectCommand).resolves({});
    await expect(s.verifyUpload(rec, p.uploadToken)).rejects.toThrow(/does not match/);
    expect(s3.commandCalls(DeleteObjectCommand)[0]!.args[0].input.Key).toBe(REC_KEY);
    await expect(s.verifyUpload(rec, p.uploadToken)).rejects.toThrow(/already used/);
  });
  it('rejects malformed tokens without touching S3', async () => {
    await expect(svc().verifyUpload(rec, 'nope')).rejects.toThrow(/Invalid upload token/);
    expect(s3.calls()).toHaveLength(0);
  });
});

describe('verifyMultipartUpload', () => {
  const big = { mimeType: 'video/mp4', sizeBytes: 3, partSizeBytes: 5 * MB, checksumSha256: SUM };
  const parts = [{ partNumber: 1, etag: 'a', checksumSha256: SUM }];
  const setup = () => {
    s3.on(CreateMultipartUploadCommand).resolves({ UploadId: 'u1' });
    s3.on(ListPartsCommand).resolves({ Parts: [{ PartNumber: 1, ETag: 'a', ChecksumSHA256: SUM }] });
    s3.on(CompleteMultipartUploadCommand).resolves({ ETag: '"x"' });
    s3.on(HeadObjectCommand).resolves({ ContentLength: 3, ChecksumSHA256: 'composite-1', Metadata: { sha256: SUM } });
  };
  it('streams the object, verifies the declared whole-object sha256, and is retry-safe', async () => {
    setup();
    s3.on(GetObjectCommand).callsFake(() => ({ Body: body('abc') }));
    const s = svc();
    const mp = await s.createMultipartUpload(rec, big);
    const r = await s.verifyMultipartUpload(rec, 'u1', parts, mp.uploadToken);
    expect(r).toEqual({ verified: true, sha256: HEX, checksumSha256: HEX, checksumSha256Base64: SUM, sizeBytes: 3 });
    await expect(s.verifyMultipartUpload(rec, 'u1', parts, mp.uploadToken)).resolves.toEqual(r);
    expect(s3.commandCalls(CompleteMultipartUploadCommand)).toHaveLength(1);
  });
  it('deletes and rejects when the streamed hash differs', async () => {
    setup();
    s3.on(GetObjectCommand).callsFake(() => ({ Body: body('abd') }));
    s3.on(DeleteObjectCommand).resolves({});
    const s = svc();
    const mp = await s.createMultipartUpload(rec, big);
    await expect(s.verifyMultipartUpload(rec, 'u1', parts, mp.uploadToken)).rejects.toThrow(/declared sha256/);
    expect(s3.commandCalls(DeleteObjectCommand)).toHaveLength(1);
  });
});

describe('abortStaleMultipartUploads', () => {
  it('aborts only uploads initiated before the cutoff, across pages', async () => {
    const old = new Date('2026-01-01T00:00:00Z');
    const fresh = new Date('2026-12-01T00:00:00Z');
    s3.on(ListMultipartUploadsCommand, { Prefix: 'organizations/' })
      .resolvesOnce({ IsTruncated: true, NextKeyMarker: 'k', NextUploadIdMarker: 'u', Uploads: [{ Key: REC_KEY, UploadId: 'a', Initiated: old }] })
      .resolvesOnce({ IsTruncated: false, Uploads: [{ Key: REC_KEY, UploadId: 'b', Initiated: fresh }] });
    s3.on(ListMultipartUploadsCommand, { Prefix: 'tmp/session-chunks/' }).resolves({ IsTruncated: false, Uploads: [] });
    s3.on(AbortMultipartUploadCommand).resolves({});
    const r = await svc().abortStaleMultipartUploads(new Date('2026-06-01T00:00:00Z'));
    expect(r).toEqual({ aborted: 1 });
    expect(s3.commandCalls(AbortMultipartUploadCommand)[0]!.args[0].input).toMatchObject({ Key: REC_KEY, UploadId: 'a' });
  });
});
