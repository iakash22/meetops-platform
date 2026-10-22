import { describe, expect, it, vi } from 'vitest';
import {
  createTranscriptionQueueConsumer,
  InvalidTranscriptionJobError,
  parseTranscriptionIdempotencyKey,
  toChunkJob,
  transcriptionIdempotencyKey,
  transcriptionJobId,
  type MediaTranscriptionJob,
} from '../src/index.js';

const ORG = '00000000-0000-4000-8000-0000000000c1';
const MEET = '10000000-0000-4000-8000-000000000001';
const REC = '30000000-0000-4000-8000-000000000001';
const FILE = '40000000-0000-4000-8000-000000000003';

const job = (index: number, o: Partial<MediaTranscriptionJob> = {}): MediaTranscriptionJob => ({
  jobVersion: 1, organizationId: ORG, idempotencyKey: transcriptionIdempotencyKey(REC, index), kind: 'transcribe_recording',
  meetingId: MEET, recordingId: REC, fileObjectId: FILE, sttProviderId: 'assemblyai', diarize: true, chunkIndex: index, startMs: index * 600_000, ...o,
});

describe('Media transcription queue (PR #39) consumer', () => {
  it('parses idempotency keys like Media', () => {
    expect(parseTranscriptionIdempotencyKey(`transcribe:${REC}:12`)).toEqual({ recordingId: REC, index: 12 });
    for (const bad of [`transcribe:${REC}:`, `transcribe:${REC}:123456`, `stt:${REC}:1`, `transcribe:a:b:1`, `transcribe:${REC}:-1`]) {
      expect(parseTranscriptionIdempotencyKey(bad)).toBeNull();
    }
    expect(transcriptionJobId(ORG, REC, 7)).toBe(`transcribe_${ORG}_${REC}_00007`);
  });

  it('uses contracts chunkIndex/startMs', () => {
    const p = toChunkJob(job(3, { startMs: 1_799_500 }), transcriptionJobId(ORG, REC, 3), { segmentSeconds: 600 });
    expect(p.chunk).toEqual({ index: 3, startSec: 1799.5, durationSec: 600, overlapSec: 0, fileObjectId: FILE });
    expect('chunkIndex' in p || 'startMs' in p).toBe(false);
    const { startMs: _s, ...noStart } = job(2);
    void _s;
    expect(toChunkJob(noStart, undefined, { segmentSeconds: 600 }).chunk.startSec).toBe(1200);
  });

  it('rejects jobs without chunkIndex or with an inconsistent key/job id', () => {
    const { chunkIndex: _c, ...whole } = job(1);
    void _c;
    expect(() => toChunkJob(whole, undefined, { segmentSeconds: 600 })).toThrow(/chunkIndex/);
    expect(() => toChunkJob(job(2, { chunkIndex: 5 }), undefined, { segmentSeconds: 600 })).toThrow(InvalidTranscriptionJobError);
    const other = '30000000-0000-4000-8000-000000000002';
    expect(() => toChunkJob(job(1, { recordingId: other }), undefined, { segmentSeconds: 600 })).toThrow(/idempotencyKey/);
    expect(() => toChunkJob(job(1), transcriptionJobId(ORG, REC, 2), { segmentSeconds: 600 })).toThrow(/job id/);
    expect(toChunkJob(job(1, { idempotencyKey: 'custom-key' }), undefined, { segmentSeconds: 600 }).chunk.index).toBe(1);
  });

  it('feeds the handler', async () => {
    const handle = vi.fn(async () => ({ status: 'failed' as const, errors: [] }));
    const consume = createTranscriptionQueueConsumer({ handle }, { segmentSeconds: 30 });
    await consume({ id: transcriptionJobId(ORG, REC, 1), data: job(1) });
    expect(handle).toHaveBeenCalledWith(expect.objectContaining({ chunk: expect.objectContaining({ index: 1, startSec: 600 }) }));
  });
});
