/** Test harness: the deps startMediaWorker builds (buildMediaProcessorDeps), with in-memory storage/queue/emitter
 * and fake ffmpeg steps (three chunks: 10 s, 10 s, 5 s). The source object for `job` is pre-stored. */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { vi } from 'vitest';
import { buildObjectKey, StorageNotFoundError, type MeetingObjectRef } from '@meetops/storage';
import {
  buildMediaProcessorDeps,
  createPersistedChunkAudioResolver,
  createRealtimePublisher,
  loadMediaWorkerConfig,
  type MediaJobPayload,
  type MediaProcessorDeps,
  type MediaWorkerParts,
  type TranscriptionJobPayload,
} from '../src/media/index.js';

export interface WorkerHarness {
  /** What processRecording runs: `built` with only the ffmpeg-backed steps faked. */
  deps: MediaProcessorDeps;
  /** Exactly what buildMediaProcessorDeps (startMediaWorker) produced. */
  built: MediaProcessorDeps;
  stored: Map<string, Buffer>;
  jobs: Map<string, TranscriptionJobPayload>;
  events: Array<{ rooms: string[]; event: string; payload: unknown }>;
  storage: HarnessStorage;
}

/** The worker's storage surface plus what the chunk audio resolver reads. */
export type HarnessStorage = MediaWorkerParts['storage'] &
  Parameters<typeof createPersistedChunkAudioResolver>[0];

export function makeWorkerParts(
  tmpRoot: string,
  persistence: MediaWorkerParts['persistence'],
  job: MediaJobPayload,
): WorkerHarness {
  const stored = new Map<string, Buffer>();
  const jobs = new Map<string, TranscriptionJobPayload>();
  const events: Array<{ rooms: string[]; event: string; payload: unknown }> = [];
  const getObjectByKey = vi.fn(async (ref: { key: string }) => {
    const b = stored.get(ref.key);
    if (!b) throw new StorageNotFoundError();
    return { body: Readable.from([b]), info: { sizeBytes: b.length } };
  });
  const fakeStorage = {
    getObjectByKey,
    headObjectByKey: vi.fn(async (ref: { key: string }) =>
      stored.has(ref.key) ? { sizeBytes: stored.get(ref.key)!.length } : null,
    ),
    putObject: vi.fn(async (ref: MeetingObjectRef, body: Readable) => {
      const parts: Buffer[] = [];
      for await (const c of body) parts.push(Buffer.from(c as Uint8Array));
      stored.set(buildObjectKey(ref), Buffer.concat(parts));
      return {};
    }),
    putDerivedJson: vi.fn(async (ref: MeetingObjectRef, value: unknown) => {
      const b = Buffer.from(JSON.stringify(value));
      stored.set(buildObjectKey(ref), b);
      return { sizeBytes: b.length };
    }),
    getPresignedDownloadUrlByKey: vi.fn(),
  };
  const storage = fakeStorage as unknown as HarnessStorage;
  const emitter = {
    to: (rooms: string | string[]) => ({
      emit: (event: string, p: unknown) =>
        void events.push({ rooms: [rooms].flat(), event, payload: p }),
    }),
  };
  const cfg = { ...loadMediaWorkerConfig({}), tmpRoot };
  const built = buildMediaProcessorDeps(cfg, {
    storage,
    transcriptionQueue: {
      add: async (_n, data, opts) => void (jobs.has(opts.jobId) || jobs.set(opts.jobId, data)),
    },
    realtime: createRealtimePublisher(emitter),
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    persistence,
  });
  // Swap only the ffmpeg-backed steps for fakes; everything else is exactly what startMediaWorker runs.
  const deps: MediaProcessorDeps = {
    ...built,
    media: {
      probeMedia: async () => ({
        durationSeconds: 25,
        formatName: 'matroska,webm',
        streams: [],
        hasAudio: true,
        hasVideo: false,
      }),
      normalizeToWav: async (_i, o) => (writeFileSync(o, 'WAVDATA'), o),
      chunkAudio: async (_i, outDir) => {
        mkdirSync(outDir, { recursive: true });
        return [0, 1, 2].map((index) => {
          const p = path.join(outDir, `chunk-${index}.wav`);
          writeFileSync(p, `C${index}`);
          return {
            index,
            path: p,
            startSeconds: index * 10,
            durationSeconds: index === 2 ? 5 : 10,
          };
        });
      },
    },
    waveform: {
      ...built.waveform!,
      compute: async () => ({
        version: 1,
        sampleRate: 16000,
        channels: 1,
        durationMs: 25000,
        bins: 1,
        peaks: [0.5],
      }),
    },
  };
  stored.set(
    buildObjectKey({
      organizationId: job.organizationId,
      meetingId: job.meetingId,
      kind: 'recording',
      objectId: job.recordingId,
      ext: job.sourceExt,
    }),
    Buffer.from('SOURCE'),
  );
  return { deps, built, stored, jobs, events, storage };
}
