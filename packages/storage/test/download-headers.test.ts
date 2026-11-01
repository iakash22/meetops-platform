import { describe, expect, it, vi } from 'vitest';
import { S3Client } from '@aws-sdk/client-s3';
import {
  assertBucketPrivate,
  downloadContentType,
  loadStorageConfig,
  S3StorageService,
  type MeetingObjectRef,
} from '../src/index.js';

const config = loadStorageConfig({
  STORAGE_BUCKET: 'b',
  STORAGE_ENDPOINT: 'http://localhost:9000',
  STORAGE_ACCESS_KEY_ID: 'a',
  STORAGE_SECRET_ACCESS_KEY: 's',
});
const rec: MeetingObjectRef = {
  organizationId: 'o1',
  meetingId: 'm1',
  kind: 'recording',
  objectId: 'r1',
  ext: 'webm',
};

describe('security review B 4.1: presigned downloads are attachments with a fixed type', () => {
  it('maps content types to an allowlisted base type or octet-stream', () => {
    expect(downloadContentType('audio/webm;codecs=opus')).toBe('audio/webm');
    expect(downloadContentType('VIDEO/MP4')).toBe('video/mp4');
    expect(downloadContentType('audio/aac')).toBe('audio/aac');
    for (const bad of [undefined, '', 'text/html', 'image/svg+xml', 'application/javascript'])
      expect(downloadContentType(bad)).toBe('application/octet-stream');
  });

  it('every presigned GET forces Content-Disposition attachment and Content-Type', async () => {
    const presign = vi.fn().mockResolvedValue('https://signed');
    const s = new S3StorageService({
      config,
      client: new S3Client({ region: 'us-east-1' }),
      authorize: () => undefined,
      presign,
    });
    await s.getPresignedDownloadUrl(rec);
    await s.getPresignedDownloadUrl(rec, { contentType: 'text/html' });
    await s.getPresignedDownloadUrl(rec, { contentType: 'audio/webm;codecs=opus' });
    const inputs = presign.mock.calls.map(
      (c) => (c[1] as { input: Record<string, unknown> }).input,
    );
    expect(inputs.map((i) => i.ResponseContentDisposition)).toEqual([
      'attachment',
      'attachment',
      'attachment',
    ]);
    expect(inputs.map((i) => i.ResponseContentType)).toEqual([
      'application/octet-stream',
      'application/octet-stream',
      'audio/webm',
    ]);
  });

  it('assertBucketPrivate fails closed on public, and on unknown unless allowed', () => {
    expect(() => assertBucketPrivate({ status: 'public' })).toThrow(/public/);
    expect(() => assertBucketPrivate({ status: 'public' }, { allowUnknown: true })).toThrow();
    expect(() => assertBucketPrivate({ status: 'unknown' })).toThrow(/could not be verified/);
    expect(() => assertBucketPrivate({ status: 'unknown' }, { allowUnknown: true })).not.toThrow();
    expect(() => assertBucketPrivate({ status: 'private' })).not.toThrow();
  });
});
