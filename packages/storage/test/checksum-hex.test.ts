import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import {
  S3StorageService,
  StorageValidationError,
  isSha256Hex,
  loadStorageConfig,
  sha256Base64ToHex,
  sha256HexToBase64,
  type MeetingObjectRef
} from '../src/index.js';

const B64 = 'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0='; // sha256('abc')
const HEX = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const s3 = mockClient(S3Client);
const svc = () =>
  new S3StorageService({
    config: loadStorageConfig({ STORAGE_BUCKET: 'b', STORAGE_ENDPOINT: 'http://localhost:9000', STORAGE_ACCESS_KEY_ID: 'a', STORAGE_SECRET_ACCESS_KEY: 's' }),
    client: new S3Client({ region: 'us-east-1', credentials: { accessKeyId: 'a', secretAccessKey: 's' } }),
    presign: vi.fn(),
    authorize: () => undefined
  });
const ref: MeetingObjectRef = { organizationId: 'o1', meetingId: 'm1', kind: 'recording', objectId: 'r1', ext: 'webm' };
beforeEach(() => s3.reset());

describe('sha256 encoding helpers', () => {
  it('converts base64 <-> lowercase 64-char hex', () => {
    expect(sha256Base64ToHex(B64)).toBe(HEX);
    expect(sha256HexToBase64(HEX)).toBe(B64);
    expect(isSha256Hex(HEX)).toBe(true);
  });
  it('rejects malformed and wrong-length values', () => {
    for (const bad of ['', 'abc', B64.slice(0, -1), B64.replace('=', ''), `${B64}=`, 'A'.repeat(43) + '=' + 'A', Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64'), `${B64}-3`, HEX, 42, null]) {
      expect(() => sha256Base64ToHex(bad)).toThrow(StorageValidationError);
    }
    for (const bad of [HEX.toUpperCase(), HEX.slice(1), `${HEX}0`, `g${HEX.slice(1)}`, B64, undefined]) {
      expect(() => sha256HexToBase64(bad)).toThrow(StorageValidationError);
    }
  });
});

describe('S3 boundary: StoredObjectInfo and FileObject carry hex', () => {
  it('headObject and describeObject convert S3 base64 ChecksumSHA256 to hex', async () => {
    s3.on(HeadObjectCommand).resolves({ ContentLength: 3, ChecksumSHA256: B64, ContentType: 'audio/webm' });
    const s = svc();
    expect((await s.headObject(ref))?.checksumSha256).toBe(HEX);
    const f = await s.describeObject(ref, '00000000-0000-4000-8000-000000000001');
    expect(f?.checksumSha256).toBe(HEX);
    expect(f?.checksumSha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it('omits multipart composite checksums instead of mis-converting them', async () => {
    s3.on(HeadObjectCommand).resolves({ ContentLength: 3, ChecksumSHA256: `${B64}-4` });
    const info = await svc().headObject(ref);
    expect(info).not.toHaveProperty('checksumSha256');
  });
  it('rejects a malformed provider checksum', async () => {
    s3.on(HeadObjectCommand).resolves({ ContentLength: 3, ChecksumSHA256: 'not-base64!' });
    await expect(svc().headObject(ref)).rejects.toThrow(StorageValidationError);
  });
});
