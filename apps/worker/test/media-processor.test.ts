import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptionJobPayload as Schema } from '@meetops/contracts';
import { Value } from '@sinclair/typebox/value';
import { chunkAudio, computeWaveform, normalizeToWav, probeMedia, type Waveform } from '@meetops/media-core';
import { buildObjectKey, createChunkAudioResolver, StorageNotFoundError, type MeetingObjectRef } from '@meetops/storage';
import {
  createRealtimePublisher,
  publishUploadStatus,
  enqueueMediaJob,
  parseTranscriptionIdempotencyKey,
  chunkFileObjectId,
  uuidV5,
  processRecording,
  type MediaJobPayload,
  workerAuthorize,
  runInJobScope,
  type ChunkFileObjectRepository,
  type MediaOps,
  type MediaProcessorDeps,
  type TranscriptionJobPayload
} from '../src/media/index.js';
import * as ids from '../src/media/ids.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const MEET = '22222222-2222-4222-8222-222222222222';
const REC = '33333333-3333-4333-8333-333333333333';
const payload: MediaJobPayload = {
  jobVersion: 1,
  kind: 'process_recording',
  organizationId: ORG,
  meetingId: MEET,
  recordingId: REC,
  sourceExt: 'webm'
};

function makeDeps(over: Partial<MediaProcessorDeps> = {}, tmpRoot?: string) {
  const stored = new Map<string, Buffer>();
  const jobs = new Map<string, TranscriptionJobPayload>();
  const events: Array<{ rooms: string[]; event: string; payload: unknown }> = [];
  const logs: Array<{ level: string; obj: object; msg: string }> = [];
  const getObject = vi.fn(async (ref: MeetingObjectRef | { key: string }) => {
      const key = 'key' in ref ? ref.key : buildObjectKey(ref);
      const b = stored.get(key);
      if (!b) throw new StorageNotFoundError();
      return { body: Readable.from([b]), info: { sizeBytes: b.length } };
    });
  const headObject = vi.fn(async (ref: MeetingObjectRef | { key: string }) => {
    const b = stored.get('key' in ref ? ref.key : buildObjectKey(ref));
    return b ? { sizeBytes: b.length } : null;
  });
  const storage = {
    getObject,
    headObject,
    getObjectByKey: getObject,
    headObjectByKey: headObject,
    putObject: vi.fn(async (ref: MeetingObjectRef, body: unknown, spec: { sizeBytes: number; mimeType: string }) => {
      const chunks: Buffer[] = [];
      for await (const c of body as Readable) chunks.push(c as Buffer);
      const buf = Buffer.concat(chunks);
      expect(buf.length).toBe(spec.sizeBytes);
      stored.set(buildObjectKey(ref), buf);
      return {};
    })
  };
  const emitter = { to: (rooms: string | string[]) => ({ emit: (event: string, p: unknown) => events.push({ rooms: [rooms].flat(), event, payload: p }) }) };
  const add = vi.fn(async (_n: string, data: TranscriptionJobPayload, opts: { jobId: string }) => {
    if (!jobs.has(opts.jobId)) jobs.set(opts.jobId, data); // BullMQ semantics: duplicate jobId is a no-op
  });
  const probeMedia = vi.fn<MediaOps['probeMedia']>(async () => ({ durationSeconds: 25, formatName: 'matroska,webm', streams: [], hasAudio: true, hasVideo: false }));
  const normalizeToWav = vi.fn<MediaOps['normalizeToWav']>(async (_i, o) => {
    writeFileSync(o, 'WAVDATA');
    return o;
  });
  const deps: MediaProcessorDeps = {
    storage,
    media: {
      probeMedia,
      normalizeToWav,
      chunkAudio: vi.fn(async (_i: string, outDir: string) => {
        const { mkdirSync } = await import('node:fs');
        mkdirSync(outDir, { recursive: true });
        return [0, 1, 2].map((index) => {
          const p = path.join(outDir, `chunk-${index}.wav`);
          writeFileSync(p, `C${index}`);
          return { index, path: p, startSeconds: index * 10, durationSeconds: index === 2 ? 5 : 10 };
        });
      })
    },
    transcriptionQueue: { add },
    realtime: createRealtimePublisher(emitter),
    logger: {
      info: (obj, msg) => logs.push({ level: 'info', obj, msg }),
      warn: (obj, msg) => logs.push({ level: 'warn', obj, msg }),
      error: (obj, msg) => logs.push({ level: 'error', obj, msg })
    },
    now: () => new Date('2026-10-21T00:00:00Z'),
    ...(tmpRoot ? { tmpRoot } : {}),
    ...over
  };
  const srcKey = buildObjectKey({ organizationId: ORG, meetingId: MEET, kind: 'recording', objectId: REC, ext: 'webm' });
  stored.set(srcKey, Buffer.from('SOURCE'));
  return { deps, stored, jobs, events, logs, srcKey, getObject, add, headObject, probeMedia, normalizeToWav };
}

const root = mkdtempSync(path.join(tmpdir(), 'worker-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(root, 't-'));
});

describe('processRecording (mocked storage, queue, emitter)', () => {
  it('uploads outputs, enqueues one contract-valid job per chunk, emits events, cleans temp', async () => {
    const { deps, stored, jobs, events, logs, srcKey, probeMedia: probeMock, normalizeToWav: normMock } = makeDeps({}, tmpRoot);
    const res = await processRecording({ ...payload, sourceKey: srcKey }, deps, { jobId: 'j1', isFinalAttempt: true });

    expect([...stored.keys()].sort()).toEqual([
      `organizations/${ORG}/meetings/${MEET}/processed/${REC}/chunks/00000.wav`,
      `organizations/${ORG}/meetings/${MEET}/processed/${REC}/chunks/00001.wav`,
      `organizations/${ORG}/meetings/${MEET}/processed/${REC}/chunks/00002.wav`,
      `organizations/${ORG}/meetings/${MEET}/processed/${REC}/normalized.wav`,
      srcKey
    ]);
    expect(res.chunks.map((c) => [c.index, c.startMs, c.durationMs])).toEqual([[0, 0, 10000], [1, 10000, 10000], [2, 20000, 5000]]);
    expect([...jobs.keys()]).toEqual([0, 1, 2].map((i) => `transcribe_${ORG}_${REC}_0000${i}`));
    for (const j of jobs.values()) expect(Value.Check(Schema, j)).toBe(true);
    const j1 = jobs.get(`transcribe_${ORG}_${REC}_00001`)!;
    expect(parseTranscriptionIdempotencyKey(j1.idempotencyKey)).toEqual({ recordingId: REC, index: 1 });
    expect(j1.fileObjectId).toBe(chunkFileObjectId(REC, 1));
    expect(j1.chunkIndex).toBe(1);
    expect(j1.startMs).toBe(10000);
    expect(probeMock.mock.calls[0]![1]).toEqual({ format: 'matroska' });
    expect(normMock.mock.calls[0]![2]).toEqual({ inputFormat: 'matroska', maxDurationSeconds: 14400, maxOutputBytes: 14400 * 32000 + 65536, maxInputBytes: 1_400_000_000 });
    expect(chunkFileObjectId(REC, 1)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // RFC 4122 test vector: uuidv5(DNS namespace, 'www.example.com')
    expect(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');

    expect(events.every((e) => e.rooms.includes(`organizations:${ORG}:meetings:${MEET}`) && e.rooms.includes(`organizations:${ORG}`))).toBe(true);
    expect(events[0]).toMatchObject({ event: 'meeting:status', payload: { status: 'processing', organizationId: ORG } });
    const stages = events.filter((e) => e.event === 'transcription:progress').map((e) => (e.payload as { stage: string }).stage);
    expect(stages).toEqual(['normalizing', 'chunking', 'chunking', 'chunking', 'chunking', 'transcribing']);
    const proc = events.filter((e) => e.event === 'processing:status').map((e) => e.payload as { status: string; recordingId: string });
    expect(proc.map((p) => p.status)).toEqual(['normalizing', 'chunking', 'completed']);
    expect(proc.every((p) => p.recordingId === REC)).toBe(true);

    expect(readdirSync(tmpRoot)).toEqual([]);
    expect(JSON.stringify(logs)).not.toMatch(/organizations\/|org\/|https?:\/\/|\.wav/);
  });

  it('is idempotent: a retry overwrites the same keys and creates no duplicate jobs', async () => {
    const { deps, stored, jobs, add } = makeDeps({}, tmpRoot);
    await processRecording(payload, deps);
    const keys = [...stored.keys()].sort();
    await processRecording(payload, deps);
    expect([...stored.keys()].sort()).toEqual(keys);
    expect(jobs.size).toBe(3);
    expect(add.mock.calls.map((c) => c[2].jobId)).toEqual([...jobs.keys(), ...jobs.keys()]);
  });

  it('reads a legacy org/ sourceKey as stored (no rebuild); rejects legacy keys of other organizations', async () => {
    const { deps, stored, srcKey, getObject } = makeDeps({}, tmpRoot);
    const legacy = srcKey.replace(/^organizations\//, 'org/');
    stored.set(legacy, stored.get(srcKey)!);
    stored.delete(srcKey);
    await processRecording({ ...payload, sourceKey: legacy }, deps);
    expect(getObject.mock.calls[0]![0]).toEqual({ organizationId: ORG, meetingId: MEET, key: legacy });
    const other = legacy.replace(`org/${ORG}/`, 'org/44444444-4444-4444-8444-444444444444/');
    await expect(processRecording({ ...payload, sourceKey: other }, deps)).rejects.toThrow(/Access denied/);
    await expect(processRecording({ ...payload, sourceKey: legacy.replace(`${REC}.webm`, 'other.webm') }, deps)).rejects.toThrow(/does not match/);
    // Writers still only emit organizations/ keys.
    expect([...stored.keys()].filter((k) => k !== legacy).every((k) => k.startsWith(`organizations/${ORG}/`))).toBe(true);
  });
  it('rejects a sourceKey from another org before touching storage', async () => {
    const { deps, getObject } = makeDeps({}, tmpRoot);
    await expect(processRecording({ ...payload, sourceKey: `organizations/44444444-4444-4444-8444-444444444444/meetings/${MEET}/recordings/${REC}.webm` }, deps)).rejects.toThrow();
    await expect(processRecording({ ...payload, sourceKey: `organizations/${ORG}/meetings/other/recordings/${REC}.webm` }, deps)).rejects.toThrow(/Access denied/);
    await expect(processRecording({ ...payload, organizationId: '../x' }, deps)).rejects.toThrow(/Invalid/);
    expect(getObject).not.toHaveBeenCalled();
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it('on failure: cleans temp, emits failed with errorCode only on final attempt, no jobs', async () => {
    const boom = Object.assign(new Error('ffmpeg exited 1 /tmp/secret/path'), { name: 'FfmpegError' });
    const { deps, events, jobs } = makeDeps({}, tmpRoot);
    deps.media.normalizeToWav = vi.fn(async () => {
      throw boom;
    });
    await expect(processRecording(payload, deps, { isFinalAttempt: false })).rejects.toBe(boom);
    expect(events.some((e) => (e.payload as { status?: string }).status === 'failed')).toBe(false);
    await expect(processRecording(payload, deps, { isFinalAttempt: true })).rejects.toBe(boom);
    const failed = events.find((e) => (e.payload as { status?: string }).status === 'failed')!;
    expect(failed.payload).toEqual({ organizationId: ORG, meetingId: MEET, status: 'failed', errorCode: 'media_processing_failed', at: '2026-10-21T00:00:00.000Z' });
    const procFailed = events.filter((e) => e.event === 'processing:status' && (e.payload as { status: string }).status === 'failed');
    expect(procFailed.map((e) => e.payload)).toEqual([
      { organizationId: ORG, meetingId: MEET, recordingId: REC, status: 'failed', errorCode: 'media_processing_failed', at: '2026-10-21T00:00:00.000Z' }
    ]);
    expect(jobs.size).toBe(0);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it('persists the STT chunk count before enqueueing transcription jobs', async () => {
    const { deps, jobs } = makeDeps({}, tmpRoot);
    const order: string[] = [];
    const setChunkCount = vi.fn(async () => void order.push(`count:${jobs.size}`));
    await processRecording(payload, { ...deps, recordings: { setChunkCount } });
    expect(setChunkCount).toHaveBeenCalledWith({ organizationId: ORG, meetingId: MEET, recordingId: REC, chunkCount: 3 });
    expect(order).toEqual(['count:0']);
    expect(jobs.size).toBe(3);
  });
  it('a chunk-count persistence failure fails the job (retryable) without enqueueing', async () => {
    const { deps, jobs } = makeDeps({}, tmpRoot);
    const setChunkCount = vi.fn(async () => Promise.reject(new Error('db down')));
    await expect(processRecording(payload, { ...deps, recordings: { setChunkCount } })).rejects.toMatchObject({ errorCode: 'chunk_count_persist_failed' });
    expect(jobs.size).toBe(0);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });
  it('upserts chunk FileObject rows (deterministic ids, exact keys) before the count and any enqueue', async () => {
    const { deps, jobs, stored } = makeDeps({}, tmpRoot);
    const order: string[] = [];
    const calls: Parameters<ChunkFileObjectRepository['upsertChunkFileObjects']>[0][] = [];
    const repo: ChunkFileObjectRepository = {
      upsertChunkFileObjects: async (q) => void (calls.push(q), order.push(`rows:${jobs.size}`))
    };
    const setChunkCount = vi.fn(async () => void order.push(`count:${jobs.size}`));
    await processRecording(payload, { ...deps, chunkFileObjects: repo, recordings: { setChunkCount } });
    expect(order).toEqual(['rows:0', 'count:0']);
    const q = calls[0]!;
    expect(q).toMatchObject({ organizationId: ORG, meetingId: MEET, recordingId: REC });
    expect(q.chunks.map((c) => c.index)).toEqual([0, 1, 2]);
    for (const c of q.chunks) {
      expect(c.fileObjectId).toBe(chunkFileObjectId(REC, c.index));
      expect(c.storageKey).toBe(`organizations/${ORG}/meetings/${MEET}/processed/${REC}/chunks/0000${c.index}.wav`);
      expect(c.mimeType).toBe('audio/wav');
      expect(c.sizeBytes).toBe(stored.get(c.storageKey)!.length);
      expect(c.sha256).toBe(createHash('sha256').update(stored.get(c.storageKey)!).digest('hex'));
    }
    expect(q.chunks[1]).toMatchObject({ startMs: 10000, durationMs: 10000 });

    // A retry produces identical rows (idempotent upsert on fileObjectId).
    await processRecording(payload, { ...deps, chunkFileObjects: repo });
    expect(calls[1]).toEqual(calls[0]);

    // The rows written are accepted by the storage audio resolver.
    const resolver = createChunkAudioResolver({
      storage: deps.storage as never,
      lookup: {
        findFileObject: async ({ organizationId, fileObjectId }) => {
          const c = q.chunks.find((x) => x.fileObjectId === fileObjectId);
          return c ? { id: c.fileObjectId, organizationId, meetingId: MEET, kind: 'chunk', key: c.storageKey, mimeType: c.mimeType, sizeBytes: c.sizeBytes, chunkIndex: c.index } : null;
        }
      }
    });
    for (const c of q.chunks) {
      const r = await resolver.bytes({ organizationId: ORG, fileObjectId: c.fileObjectId });
      expect(Buffer.from(r.bytes).equals(stored.get(c.storageKey)!)).toBe(true);
    }
    await expect(resolver.bytes({ organizationId: 'other-org', fileObjectId: q.chunks[0]!.fileObjectId })).rejects.toThrow();
  });
  it('a chunk FileObject upsert failure enqueues nothing and skips the count', async () => {
    const { deps, jobs } = makeDeps({}, tmpRoot);
    const setChunkCount = vi.fn(async () => undefined);
    const repo: ChunkFileObjectRepository = { upsertChunkFileObjects: async () => Promise.reject(new Error('db down')) };
    await expect(processRecording(payload, { ...deps, chunkFileObjects: repo, recordings: { setChunkCount } })).rejects.toMatchObject({
      errorCode: 'chunk_file_objects_persist_failed'
    });
    expect(setChunkCount).not.toHaveBeenCalled();
    expect(jobs.size).toBe(0);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });
  it('publishUploadStatus targets the organization and meeting rooms', () => {
    const sent: Array<{ rooms: string[]; event: string; payload: unknown }> = [];
    const emitter = { to: (rooms: string | string[]) => ({ emit: (event: string, p: unknown) => sent.push({ rooms: [rooms].flat(), event, payload: p }) }) };
    const e = { organizationId: ORG, meetingId: MEET, uploadId: 'up1', status: 'verified' as const, sha256: 'a'.repeat(64), at: '2026-10-21T00:00:00.000Z' };
    publishUploadStatus(emitter, e);
    expect(sent).toEqual([{ rooms: [`organizations:${ORG}:meetings:${MEET}`, `organizations:${ORG}`], event: 'upload:status', payload: e }]);
  });
  it('stores a waveform under processed/{recordingId}/waveform.json when enabled', async () => {
    const { deps } = makeDeps({}, tmpRoot);
    const w: Waveform = { version: 1, sampleRate: 16000, channels: 1, durationMs: 25000, bins: 2, peaks: [0.1, 0.2] };
    const store = vi.fn(async () => ({ sizeBytes: 42 }));
    const compute = vi.fn(async () => w);
    const res = await processRecording(payload, { ...deps, waveform: { compute, store }, waveformBins: 2 });
    expect(compute).toHaveBeenCalledWith(expect.stringMatching(/normalized\.wav$/), { bins: 2 });
    const ref = (store.mock.calls[0] as unknown as [MeetingObjectRef])[0];
    expect(buildObjectKey(ref)).toBe(`organizations/${ORG}/meetings/${MEET}/processed/${REC}/waveform.json`);
    expect(res.waveform).toEqual({ bins: 2, sizeBytes: 42 });
  });
  it('a failing waveform step is logged and does not fail the job', async () => {
    const { deps, logs, jobs } = makeDeps({}, tmpRoot);
    const res = await processRecording(payload, { ...deps, waveform: { compute: async () => Promise.reject(new Error('boom /secret/path')), store: vi.fn() } });
    expect(res.waveform).toBeUndefined();
    expect(jobs.size).toBe(3);
    const warn = logs.find((l) => l.msg === 'waveform skipped');
    expect(warn?.obj).toMatchObject({ errorCode: 'waveform_failed' });
    expect(JSON.stringify(logs)).not.toContain('/secret/path');
  });
  it('maps a missing source to source_not_found', async () => {
    const { deps, stored, srcKey, events } = makeDeps({}, tmpRoot);
    stored.delete(srcKey);
    await expect(processRecording(payload, deps)).rejects.toThrow(/Source not found/);
    expect(events.at(-1)!.payload).toMatchObject({ status: 'failed', errorCode: 'source_not_found' });
  });

  it('HEAD-checks source size before downloading', async () => {
    const { deps, getObject, events } = makeDeps({ limits: { maxSourceBytes: 3 } }, tmpRoot);
    await expect(processRecording(payload, deps)).rejects.toThrow(/size limit/);
    expect(getObject).not.toHaveBeenCalled();
    expect(events.at(-1)!.payload).toMatchObject({ status: 'failed', errorCode: 'source_too_large' });
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it('rejects forbidden/unexpected containers and over-long recordings after probing', async () => {
    for (const [formatName, re] of [['hls', /Forbidden/], ['concat', /Forbidden/], ['ogg', /Unexpected/]] as const) {
      const { deps, probeMedia: pm, normalizeToWav: nm } = makeDeps({}, tmpRoot);
      pm.mockResolvedValue({ durationSeconds: 5, formatName, streams: [], hasAudio: true, hasVideo: false });
      await expect(processRecording(payload, deps)).rejects.toThrow(re);
      expect(nm).not.toHaveBeenCalled();
    }
    const { deps } = makeDeps({ limits: { maxDurationSeconds: 10 } }, tmpRoot);
    await expect(processRecording(payload, deps)).rejects.toThrow(/duration/);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it('rejects payloads that fail the contracts MediaJobPayload schema', async () => {
    const { deps } = makeDeps({}, tmpRoot);
    await expect(processRecording({ ...payload, sourceExt: 'm3u8' } as never, deps)).rejects.toThrow(/Invalid media job payload/);
    await expect(processRecording({ ...payload, extra: 1 } as never, deps)).rejects.toThrow(/Invalid media job payload/);
  });

  it('worker authorize hook only allows the current job scope', async () => {
    const ref = { organizationId: ORG, meetingId: MEET, kind: 'recording' as const, objectId: REC, ext: 'webm' };
    expect(() => workerAuthorize(ref)).toThrow();
    await runInJobScope({ organizationId: ORG, meetingId: MEET }, async () => {
      expect(() => workerAuthorize(ref)).not.toThrow();
      expect(() => workerAuthorize({ ...ref, meetingId: '55555555-5555-4555-8555-555555555555' })).toThrow();
      // Stored-key reads and deprecated orgId refs are checked too; a ref naming two organizations is denied.
      expect(() => workerAuthorize({ organizationId: ORG, meetingId: MEET, key: `organizations/${ORG}/meetings/${MEET}/recordings/${REC}.webm` })).not.toThrow();
      expect(() => workerAuthorize({ ...ref, orgId: '66666666-6666-4666-8666-666666666666' })).toThrow();
    });
  });

  it('enqueueMediaJob uses a deterministic jobId', async () => {
    const add = vi.fn();
    await enqueueMediaJob({ add } as never, payload);
    expect(add.mock.calls[0]![2]).toMatchObject({ jobId: `media_${ORG}_${REC}`, attempts: 3 });
  });
});

function has(bin: string) {
  try {
    execFileSync(bin, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!has('ffmpeg') || !has('ffprobe'))('processRecording with real ffmpeg', () => {
  it('normalizes and chunks a real file end to end', async () => {
    const { deps, stored, jobs, srcKey } = makeDeps({}, tmpRoot);
    const src = path.join(root, 'tone.webm');
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=25', '-ac', '2', '-c:a', 'libopus', src]);
    stored.set(srcKey, readFileSync(src));
    deps.media = { probeMedia: (p, o) => probeMedia(p, o), normalizeToWav: (i, o, x) => normalizeToWav(i, o, x), chunkAudio: (i, o, x) => chunkAudio(i, o, x) };
    const waves: Waveform[] = [];
    deps.waveform = { compute: (p, o) => computeWaveform(p, o), store: async (_r, w) => (waves.push(w), { sizeBytes: JSON.stringify(w).length }) };
    const res = await processRecording(payload, { ...deps, segmentSeconds: 10, waveformBins: 250 });
    expect(res.waveform?.bins).toBe(250);
    expect(waves[0]).toMatchObject({ sampleRate: 16000, channels: 1, bins: 250 });
    expect(res.chunks).toHaveLength(3);
    expect(res.durationMs).toBeGreaterThan(24000);
    const wavKey = `organizations/${ORG}/meetings/${MEET}/processed/${REC}/normalized.wav`;
    const probeOut = path.join(root, 'n.wav');
    writeFileSync(probeOut, stored.get(wavKey)!);
    expect((await probeMedia(probeOut, { format: 'wav' })).streams[0]).toMatchObject({ sampleRate: 16000, channels: 1, codecName: 'pcm_s16le' });
    expect(jobs.size).toBe(3);
    expect(existsSync(tmpRoot) && readdirSync(tmpRoot)).toEqual([]);
  }, 240000);
});

describe('media ids', () => {

  it('MEDIA_UUID_NAMESPACE is pinned (changing it breaks every stored deterministic id)', () => {
    expect(ids.MEDIA_UUID_NAMESPACE).toBe('6f0d3a4e-1c2b-5d7e-9f80-a1b2c3d4e5f6');
    expect(ids.chunkFileObjectId('0b9c2f4e-6a1d-4c3b-8e2f-1a2b3c4d5e6f', 1)).toBe('3dd82417-1fb6-5e1e-83f1-d19140a21ffc');
  });

  it('assertId enforces the contracts Id (uuid) format', () => {
    expect(ids.assertId('recordingId', REC)).toBe(REC);
    expect(ids.assertId('fileObjectId', ids.chunkFileObjectId(REC, 0))).toBe(ids.chunkFileObjectId(REC, 0));
    for (const bad of ['rec_123', '', 'not-a-uuid', `${REC}x`, '33333333-3333-0333-8333-333333333333', 42, null, undefined]) {
      expect(() => ids.assertId('recordingId', bad)).toThrow('Invalid recordingId');
    }
  });
});
