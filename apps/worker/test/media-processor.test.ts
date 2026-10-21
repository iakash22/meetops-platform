import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { TranscriptionJobPayload as Schema } from '@meetops/contracts';
import { Value } from '@sinclair/typebox/value';
import { chunkAudio, normalizeToWav, probeMedia } from '@meetops/media-core';
import { buildObjectKey, StorageNotFoundError, type MeetingObjectRef } from '@meetops/storage';
import {
  createRealtimePublisher,
  enqueueMediaJob,
  parseTranscriptionIdempotencyKey,
  chunkFileObjectId,
  uuidV5,
  processRecording,
  type MediaProcessingJobPayload,
  type MediaProcessorDeps,
  type TranscriptionJobPayload
} from '../src/media/index.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const MEET = '22222222-2222-4222-8222-222222222222';
const REC = '33333333-3333-4333-8333-333333333333';
const payload: MediaProcessingJobPayload = {
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
  const getObject = vi.fn(async (ref: MeetingObjectRef) => {
      const key = buildObjectKey(ref);
      const b = stored.get(key);
      if (!b) throw new StorageNotFoundError();
      return { body: Readable.from([b]), info: { sizeBytes: b.length } };
    });
  const storage: MediaProcessorDeps['storage'] = {
    getObject,
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
  const deps: MediaProcessorDeps = {
    storage,
    media: {
      probeMedia: vi.fn(async () => ({ durationSeconds: 25, formatName: 'webm', streams: [], hasAudio: true, hasVideo: false })),
      normalizeToWav: vi.fn(async (_i: string, o: string) => {
        writeFileSync(o, 'WAVDATA');
        return o;
      }),
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
  const srcKey = buildObjectKey({ orgId: ORG, meetingId: MEET, kind: 'recording', objectId: REC, ext: 'webm' });
  stored.set(srcKey, Buffer.from('SOURCE'));
  return { deps, stored, jobs, events, logs, srcKey, getObject, add };
}

const root = mkdtempSync(path.join(tmpdir(), 'worker-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let tmpRoot: string;
beforeEach(() => {
  tmpRoot = mkdtempSync(path.join(root, 't-'));
});

describe('processRecording (mocked storage, queue, emitter)', () => {
  it('uploads outputs, enqueues one contract-valid job per chunk, emits events, cleans temp', async () => {
    const { deps, stored, jobs, events, logs, srcKey } = makeDeps({}, tmpRoot);
    const res = await processRecording({ ...payload, sourceKey: srcKey }, deps, { jobId: 'j1', isFinalAttempt: true });

    expect([...stored.keys()].sort()).toEqual([
      `org/${ORG}/meetings/${MEET}/processed/${REC}/chunks/00000.wav`,
      `org/${ORG}/meetings/${MEET}/processed/${REC}/chunks/00001.wav`,
      `org/${ORG}/meetings/${MEET}/processed/${REC}/chunks/00002.wav`,
      `org/${ORG}/meetings/${MEET}/processed/${REC}/normalized.wav`,
      srcKey
    ]);
    expect(res.chunks.map((c) => [c.index, c.startMs, c.durationMs])).toEqual([[0, 0, 10000], [1, 10000, 10000], [2, 20000, 5000]]);
    expect([...jobs.keys()]).toEqual([0, 1, 2].map((i) => `transcribe_${ORG}_${REC}_0000${i}`));
    for (const j of jobs.values()) expect(Value.Check(Schema, j)).toBe(true);
    const j1 = jobs.get(`transcribe_${ORG}_${REC}_00001`)!;
    expect(parseTranscriptionIdempotencyKey(j1.idempotencyKey)).toEqual({ recordingId: REC, index: 1 });
    expect(j1.fileObjectId).toBe(chunkFileObjectId(REC, 1));
    expect(chunkFileObjectId(REC, 1)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    // RFC 4122 test vector: uuidv5(DNS namespace, 'www.example.com')
    expect(uuidV5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');

    expect(events.every((e) => e.rooms.includes(`meeting:${MEET}`) && e.rooms.includes(`org:${ORG}`))).toBe(true);
    expect(events[0]).toMatchObject({ event: 'meeting:status', payload: { status: 'processing', organizationId: ORG } });
    const stages = events.filter((e) => e.event === 'transcription:progress').map((e) => (e.payload as { stage: string }).stage);
    expect(stages).toEqual(['normalizing', 'chunking', 'chunking', 'chunking', 'chunking', 'transcribing']);

    expect(readdirSync(tmpRoot)).toEqual([]);
    expect(JSON.stringify(logs)).not.toMatch(/org\/|https?:\/\/|\.wav/);
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

  it('rejects a sourceKey from another org before touching storage', async () => {
    const { deps, getObject } = makeDeps({}, tmpRoot);
    await expect(processRecording({ ...payload, sourceKey: `org/44444444-4444-4444-8444-444444444444/meetings/${MEET}/recordings/${REC}.webm` }, deps)).rejects.toThrow();
    await expect(processRecording({ ...payload, sourceKey: `org/${ORG}/meetings/other/recordings/${REC}.webm` }, deps)).rejects.toThrow(/does not match/);
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
    expect(jobs.size).toBe(0);
    expect(readdirSync(tmpRoot)).toEqual([]);
  });

  it('maps a missing source to source_not_found', async () => {
    const { deps, stored, srcKey, events } = makeDeps({}, tmpRoot);
    stored.delete(srcKey);
    await expect(processRecording(payload, deps)).rejects.toBeInstanceOf(StorageNotFoundError);
    expect(events.at(-1)!.payload).toMatchObject({ status: 'failed', errorCode: 'source_not_found' });
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
    deps.media = { probeMedia: (p) => probeMedia(p), normalizeToWav: (i, o) => normalizeToWav(i, o), chunkAudio: (i, o, x) => chunkAudio(i, o, x) };
    const res = await processRecording(payload, { ...deps, segmentSeconds: 10 });
    expect(res.chunks).toHaveLength(3);
    expect(res.durationMs).toBeGreaterThan(24000);
    const wavKey = `org/${ORG}/meetings/${MEET}/processed/${REC}/normalized.wav`;
    const probeOut = path.join(root, 'n.wav');
    writeFileSync(probeOut, stored.get(wavKey)!);
    expect((await probeMedia(probeOut)).streams[0]).toMatchObject({ sampleRate: 16000, channels: 1, codecName: 'pcm_s16le' });
    expect(jobs.size).toBe(3);
    expect(existsSync(tmpRoot) && readdirSync(tmpRoot)).toEqual([]);
  }, 240000);
});
