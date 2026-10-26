import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  ChunkUploadUrlRequest, CompleteRecordingSessionRequest, MAX_CHUNK_BYTES, MAX_CHUNKS, MAX_RECORDING_CHUNKS,
  MAX_RECORDING_SESSION_BYTES,
} from '../src/index.js';

const h = 'ab'.repeat(32);

describe('chunk limits (B1 / NB3)', () => {
  it('MAX_CHUNKS is sane and consistent', () => {
    expect(MAX_CHUNKS).toBe(10_000);
    expect(MAX_RECORDING_CHUNKS).toBe(MAX_CHUNKS);
    expect(MAX_CHUNK_BYTES).toBeLessThan(MAX_RECORDING_SESSION_BYTES);
  });
  it('ChunkUploadUrlRequest requires sizeBytes within bounds and a required lowercase sha256', () => {
    expect(Value.Check(ChunkUploadUrlRequest, { seq: 0, sizeBytes: 1 })).toBe(false);
    expect(Value.Check(ChunkUploadUrlRequest, { seq: 0, sizeBytes: 1, sha256: h })).toBe(true);
    expect(Value.Check(ChunkUploadUrlRequest, { seq: 0, sizeBytes: MAX_CHUNK_BYTES, sha256: h })).toBe(true);
    expect(Value.Check(ChunkUploadUrlRequest, { seq: 0 })).toBe(false);
    expect(Value.Check(ChunkUploadUrlRequest, { seq: 0, sizeBytes: 0 })).toBe(false);
    expect(Value.Check(ChunkUploadUrlRequest, { seq: 0, sizeBytes: MAX_CHUNK_BYTES + 1 })).toBe(false);
    expect(Value.Check(ChunkUploadUrlRequest, { seq: 0, sizeBytes: 1, sha256: h.toUpperCase() })).toBe(false);
    expect(Value.Check(ChunkUploadUrlRequest, { seq: 0, sizeBytes: 1, sha256: 'ab' })).toBe(false);
  });
  it('seq is bounded by MAX_CHUNKS - 1', () => {
    expect(Value.Check(ChunkUploadUrlRequest, { seq: MAX_CHUNKS - 1, sizeBytes: 1, sha256: h })).toBe(true);
    expect(Value.Check(ChunkUploadUrlRequest, { seq: MAX_CHUNKS, sizeBytes: 1, sha256: h })).toBe(false);
  });
});

describe('CompleteRecordingSessionRequest chunks manifest (NB1)', () => {
  it('accepts an optional manifest', () => {
    const chunks = [{ seq: 0, sha256: h, sizeBytes: 10 }, { seq: 1, sha256: h }];
    expect(Value.Check(CompleteRecordingSessionRequest, { chunkCount: 2, durationMs: 10000, chunks })).toBe(true);
    expect(Value.Check(CompleteRecordingSessionRequest, { chunkCount: 2, durationMs: 10000 })).toBe(true);
  });
  it('validates manifest entries and size', () => {
    const c = { chunkCount: 1, durationMs: 1 };
    expect(Value.Check(CompleteRecordingSessionRequest, { ...c, chunks: [{ seq: 0 }] })).toBe(false);
    expect(Value.Check(CompleteRecordingSessionRequest, { ...c, chunks: [{ seq: 0, sha256: h, extra: 1 }] })).toBe(false);
    expect(Value.Check(CompleteRecordingSessionRequest, { ...c, chunks: [] })).toBe(false);
    expect(Value.Check(CompleteRecordingSessionRequest, { ...c, chunkCount: MAX_CHUNKS + 1 })).toBe(false);
    const many = Array.from({ length: MAX_CHUNKS + 1 }, (_, i) => ({ seq: i % MAX_CHUNKS, sha256: h }));
    expect(Value.Check(CompleteRecordingSessionRequest, { ...c, chunks: many })).toBe(false);
  });
});
