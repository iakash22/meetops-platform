import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import * as contracts from '@meetops/contracts';

/*
 * Contract-level pre-checks for the UP catalogue (chunked recording upload). These only prove the
 * request/response schemas reject the payloads; the API-level UP cases stay todo until the
 * recording-sessions routes exist (security/status.ts).
 */
const c = contracts as unknown as Record<string, unknown>;
const has = ['ChunkUploadUrlRequest', 'InitRecordingSessionRequest', 'SignedPutUpload'].every(
  (k) => k in c,
);
type Schema = Parameters<typeof Value.Check>[0];
const S = c as unknown as {
  InitRecordingSessionRequest: Schema;
  ChunkUploadUrlRequest: Schema;
  SignedPutUpload: Schema;
  MAX_CHUNK_BYTES: number;
  MAX_CHUNKS: number;
};

describe.skipIf(!has)('contracts: recording-session request schemas (UP pre-checks)', () => {
  const init = {
    mimeType: 'audio/webm',
    startedAt: '2026-10-22T10:00:00.000Z',
    source: 'tab',
    meetingId: randomUUID(),
  };

  it('control: a valid init and chunk request pass', () => {
    expect(Value.Check(S.InitRecordingSessionRequest, init)).toBe(true);
    expect(Value.Check(S.ChunkUploadUrlRequest, { seq: 0, sizeBytes: 1024 })).toBe(true);
  });

  it('[UP-01] chunk request without sizeBytes is invalid', () => {
    expect(Value.Check(S.ChunkUploadUrlRequest, { seq: 0 })).toBe(false);
  });

  it('[UP-02] chunk over 64 MiB is invalid', () => {
    expect(S.MAX_CHUNK_BYTES).toBe(64 * 1024 * 1024);
    expect(Value.Check(S.ChunkUploadUrlRequest, { seq: 0, sizeBytes: 67108865 })).toBe(false);
  });

  it('[UP-06] seq out of range is invalid', () => {
    for (const seq of [-1, S.MAX_CHUNKS, 100000, 1.5])
      expect(Value.Check(S.ChunkUploadUrlRequest, { seq, sizeBytes: 1 }), String(seq)).toBe(false);
  });

  it('[UP-13] extra fields (key, bucket, organizationId, userId) are invalid', () => {
    for (const extra of ['key', 'bucket', 'organizationId', 'userId']) {
      expect(Value.Check(S.InitRecordingSessionRequest, { ...init, [extra]: 'x' }), extra).toBe(
        false,
      );
      expect(
        Value.Check(S.ChunkUploadUrlRequest, { seq: 0, sizeBytes: 1, [extra]: 'x' }),
        extra,
      ).toBe(false);
    }
  });

  it('[UP-14] disallowed MIME types on init are invalid', () => {
    for (const mimeType of ['video/x-msvideo', 'audio/webm;foo=bar'])
      expect(Value.Check(S.InitRecordingSessionRequest, { ...init, mimeType }), mimeType).toBe(
        false,
      );
  });

  it('[UP-15] the signed upload shape cannot carry bucket/key/provider and is PUT only', () => {
    const upload = {
      url: 'https://storage.example/presigned?X-Amz-Signature=abc',
      method: 'PUT',
      headers: { 'content-length': '1024' },
      expiresAt: '2026-10-22T10:05:00.000Z',
    };
    expect(Value.Check(S.SignedPutUpload, upload)).toBe(true);
    for (const extra of ['bucket', 'key', 'provider'])
      expect(Value.Check(S.SignedPutUpload, { ...upload, [extra]: 'x' }), extra).toBe(false);
    expect(Value.Check(S.SignedPutUpload, { ...upload, method: 'POST' })).toBe(false);
  });
});
