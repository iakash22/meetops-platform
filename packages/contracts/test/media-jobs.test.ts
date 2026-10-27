import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  CHECKSUM_SHA256_HEADER,
  ChunkUploadUrlResponse,
  CreateUploadResponse,
  HttpsUrl,
  InitRecordingSessionRequest,
  MAX_CHUNKS,
  MEDIA_QUEUE,
  MEDIA_SOURCE_EXTS,
  MediaJobPayload,
  PresignedUrlDto,
  PresignedUrlString,
  QUEUE_NAMES,
  TranscriptionJobPayload,
  User,
} from '../src/index.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const at = '2026-10-21T17:00:00.000Z';
const b64 = `${'A'.repeat(43)}=`;

describe('PresignedUrlString', () => {
  it.each([
    'https://s3.amazonaws.com/b/k?X-Amz-Signature=1',
    'http://localhost:9000/b/k',
    'http://127.0.0.1:9000/b',
    'http://minio:9000/b/k?sig=1',
    'http://s3.app.localhost/b',
  ])('allows %s', (u) => expect(Value.Check(PresignedUrlString, u)).toBe(true));
  it.each([
    'http://evil.com/x',
    'http://localhost.evil.com/x',
    'http://minio.evil.com/x',
    'http://localhost@evil.com/x',
    'ftp://minio/x',
    'javascript:alert(1)',
  ])('rejects %s', (u) => expect(Value.Check(PresignedUrlString, u)).toBe(false));
  it('HttpsUrl and avatarUrl stay https-only', () => {
    expect(Value.Check(HttpsUrl, 'http://localhost/a.png')).toBe(false);
    expect(
      Value.Check(User, {
        id: id(1),
        email: 'a@b.co',
        avatarUrl: 'http://localhost/a.png',
        createdAt: at,
        updatedAt: at,
      }),
    ).toBe(false);
  });
});

describe('PresignedUrlDto union', () => {
  it('GET/PUT without fields, POST requires fields', () => {
    expect(
      Value.Check(PresignedUrlDto, { url: 'http://minio:9000/b', method: 'GET', expiresAt: at }),
    ).toBe(true);
    expect(
      Value.Check(PresignedUrlDto, {
        url: 'https://s3.x/b',
        method: 'POST',
        fields: { key: 'k', policy: 'p' },
        expiresAt: at,
      }),
    ).toBe(true);
    expect(
      Value.Check(PresignedUrlDto, { url: 'https://s3.x/b', method: 'POST', expiresAt: at }),
    ).toBe(false);
    expect(
      Value.Check(PresignedUrlDto, {
        url: 'https://s3.x/b',
        method: 'PUT',
        fields: { a: 'b' },
        expiresAt: at,
      }),
    ).toBe(false);
    expect(
      Value.Check(PresignedUrlDto, { url: 'https://s3.x/b', method: 'DELETE', expiresAt: at }),
    ).toBe(false);
  });
  it('CreateUploadResponse accepts a POST form upload', () => {
    expect(
      Value.Check(CreateUploadResponse, {
        fileObjectId: id(1),
        upload: { url: 'https://s3.x/b', method: 'POST', fields: { key: 'k' }, expiresAt: at },
      }),
    ).toBe(true);
  });
});

describe('ChunkUploadUrlResponse (SignedPutUpload)', () => {
  const ok = {
    seq: 0,
    upload: {
      url: 'https://s3.x/c0',
      method: 'PUT',
      headers: { 'content-length': '1024' },
      expiresAt: at,
    },
  };
  it('requires signed content-length', () => {
    expect(Value.Check(ChunkUploadUrlResponse, ok)).toBe(true);
    expect(
      Value.Check(ChunkUploadUrlResponse, { ...ok, upload: { ...ok.upload, headers: {} } }),
    ).toBe(false);
    const { headers: _h, ...noHeaders } = ok.upload;
    void _h;
    expect(Value.Check(ChunkUploadUrlResponse, { ...ok, upload: noHeaders })).toBe(false);
    expect(
      Value.Check(ChunkUploadUrlResponse, {
        ...ok,
        upload: { ...ok.upload, headers: { 'content-length': '0' } },
      }),
    ).toBe(false);
  });
  it('accepts the base64 checksum header and other signed headers', () => {
    expect(CHECKSUM_SHA256_HEADER).toBe('x-amz-checksum-sha256');
    const headers = {
      'content-length': '1024',
      [CHECKSUM_SHA256_HEADER]: b64,
      'content-type': 'audio/webm',
    };
    expect(Value.Check(ChunkUploadUrlResponse, { ...ok, upload: { ...ok.upload, headers } })).toBe(
      true,
    );
    expect(
      Value.Check(ChunkUploadUrlResponse, {
        ...ok,
        upload: {
          ...ok.upload,
          headers: { 'content-length': '1', [CHECKSUM_SHA256_HEADER]: 'ab'.repeat(32) },
        },
      }),
    ).toBe(false);
  });
  it('bounds seq', () => {
    expect(Value.Check(ChunkUploadUrlResponse, { ...ok, seq: MAX_CHUNKS - 1 })).toBe(true);
    expect(Value.Check(ChunkUploadUrlResponse, { ...ok, seq: MAX_CHUNKS })).toBe(false);
  });
  it('InitRecordingSessionRequest requires meetingId', () => {
    expect(
      Value.Check(InitRecordingSessionRequest, {
        mimeType: 'audio/webm',
        startedAt: at,
        source: 'tab',
      }),
    ).toBe(false);
  });
});

describe('media and transcription jobs', () => {
  const media = {
    jobVersion: 1,
    kind: 'process_recording',
    organizationId: id(1),
    meetingId: id(2),
    recordingId: id(3),
    sourceExt: 'webm',
  };
  it('MediaJobPayload', () => {
    expect(MEDIA_QUEUE).toBe('media');
    expect(QUEUE_NAMES.media).toBe(MEDIA_QUEUE);
    expect(MEDIA_SOURCE_EXTS).toEqual(['webm', 'ogg', 'mp3', 'm4a', 'mp4', 'wav']);
    expect(Value.Check(MediaJobPayload, media)).toBe(true);
    expect(
      Value.Check(MediaJobPayload, {
        ...media,
        sourceKey: `orgs/${id(1)}/meetings/${id(2)}/recording/${id(3)}.webm`,
        sttProviderId: 'faster-whisper',
        languageHint: 'hi-IN',
        requestId: 'req_1',
      }),
    ).toBe(true);
    expect(Value.Check(MediaJobPayload, { ...media, sourceExt: 'mov' })).toBe(false);
    expect(Value.Check(MediaJobPayload, { ...media, sourceKey: '../../etc passwd' })).toBe(false);
    expect(Value.Check(MediaJobPayload, { ...media, languageHint: 'x'.repeat(36) })).toBe(false);
    expect(Value.Check(MediaJobPayload, { ...media, bucket: 'b' })).toBe(false);
  });
  it('TranscriptionJobPayload chunk fields', () => {
    const t = {
      jobVersion: 1,
      organizationId: id(1),
      idempotencyKey: 'k',
      kind: 'transcribe_recording',
      meetingId: id(2),
      recordingId: id(3),
      fileObjectId: id(4),
      sttProviderId: 'assemblyai',
      diarize: true,
    };
    expect(Value.Check(TranscriptionJobPayload, t)).toBe(true);
    expect(Value.Check(TranscriptionJobPayload, { ...t, chunkIndex: 3, startMs: 1_800_000 })).toBe(
      true,
    );
    expect(Value.Check(TranscriptionJobPayload, { ...t, chunkIndex: MAX_CHUNKS })).toBe(false);
    expect(Value.Check(TranscriptionJobPayload, { ...t, startMs: -1 })).toBe(false);
  });
});

import { Value as V4 } from '@sinclair/typebox/value';
import { AbortRecordingSessionRequest as ARS } from '../src/index.js';
describe('AbortReason', () => {
  it('accepts local_storage_exhausted', () => {
    expect(V4.Check(ARS, { reason: 'local_storage_exhausted' })).toBe(true);
  });
});
