import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  MAX_MEDIA_BYTES,
  MediaJobPayload as MediaJobSchema,
  QUEUE_NAMES,
  TranscriptionJobPayload as TranscriptionJobSchema
} from '@meetops/contracts';
import type { MeetingStatusEvent, TranscriptionProgressEvent, TranscriptionStage } from '@meetops/contracts';
import { Value } from '@sinclair/typebox/value';
import type { AllowedDemuxer, AudioChunk, ProbeResult } from '@meetops/media-core';
import { assertProbedFormat, demuxerForExt } from '@meetops/media-core';
import { StorageError, assertKeyOwnedBy, buildObjectKey, parseMeetingKey, type MeetingObjectRef, type StorageService } from '@meetops/storage';
import { chunkFileObjectId, normalizedFileObjectId, transcriptionIdempotencyKey, transcriptionJobId } from './ids.js';
import type { ChunkManifestEntry, MediaJobPayload, MediaProcessingResult, TranscriptionJobPayload } from './types.js';

export type NormalizeCaps = { inputFormat: string; maxDurationSeconds: number; maxOutputBytes: number; maxInputBytes: number };

export type MediaOps = {
  probeMedia(p: string, opts: { format: string }): Promise<ProbeResult>;
  normalizeToWav(input: string, output: string, opts: NormalizeCaps): Promise<string>;
  chunkAudio(input: string, outDir: string, opts: { segmentSeconds: number }): Promise<AudioChunk[]>;
};

/**
 * Persists the number of transcription chunks produced for a recording (proposed `recordings.chunk_count`, read by
 * AI as RecordingScope.chunkCount). Must be idempotent (plain SET) and run inside withOrgContext(organizationId).
 * `recording_sessions.chunk_count` is NOT this value: it counts uploaded session parts, not STT chunks.
 */
/** One chunk FileObject row (packages/database `file_objects`, kind = chunk). */
export type ChunkFileObjectRow = {
  /** Deterministic uuidv5 of `chunk:{recordingId}:{index}` (chunkFileObjectId). Idempotency key. */
  fileObjectId: string;
  index: number;
  /** Exactly organizations/{organizationId}/meetings/{meetingId}/processed/{recordingId}/chunks/{nnnnn}.wav */
  storageKey: string;
  sizeBytes: number;
  mimeType: 'audio/wav';
  /** Lowercase hex sha256 of the stored chunk. */
  sha256?: string;
  startMs: number;
  durationMs: number;
};

/**
 * Writes chunk FileObject rows. Implemented by Database in @meetops/database; MUST be idempotent on fileObjectId
 * (upsert) and run inside withOrgContext(organizationId).
 */
export type ChunkFileObjectRepository = {
  upsertChunkFileObjects(q: { organizationId: string; meetingId: string; recordingId: string; chunks: ChunkFileObjectRow[] }): Promise<void>;
};

export type RecordingChunkCountRepository = {
  setChunkCount(q: { organizationId: string; meetingId: string; recordingId: string; chunkCount: number }): Promise<void>;
};

export type TranscriptionEnqueuer = {
  /** Must be idempotent on opts.jobId (BullMQ ignores adds with an existing jobId). */
  add(name: string, data: TranscriptionJobPayload, opts: { jobId: string }): Promise<unknown>;
};

export type RealtimePublisher = {
  meetingStatus(e: MeetingStatusEvent): void;
  transcriptionProgress(e: TranscriptionProgressEvent): void;
};

export type MinimalLogger = {
  info(obj: object, msg: string): void;
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
};

export type MediaLimits = {
  /** Max source object size (HEAD-checked before download, and enforced while streaming). */
  maxSourceBytes: number;
  /** Max recording duration in seconds (probe check + ffmpeg -t). */
  maxDurationSeconds: number;
};

export const DEFAULT_MEDIA_LIMITS: MediaLimits = { maxSourceBytes: MAX_MEDIA_BYTES, maxDurationSeconds: 4 * 60 * 60 };

/** 16 kHz mono s16le = 32000 B/s; -fs cap = duration cap worth of PCM + header slack. */
export const normalizedByteCap = (maxDurationSeconds: number) => Math.ceil(maxDurationSeconds * 32000) + 64 * 1024;

/** Worker scratch tmpfs size (/tmp/work, DevOps compose: 3g). Override with MEDIA_WORK_TMP_BYTES. */
export const DEFAULT_WORK_TMP_BYTES = 3 * 1024 ** 3;

/** Peak scratch use of one job: source + normalized WAV + WAV chunks (both capped by normalizedByteCap). */
export const peakScratchBytes = (l: MediaLimits) => l.maxSourceBytes + 2 * normalizedByteCap(l.maxDurationSeconds);

export type MediaProcessorDeps = {
  storage: Pick<StorageService, 'getObjectByKey' | 'headObjectByKey' | 'putObject'>;
  media: MediaOps;
  transcriptionQueue: TranscriptionEnqueuer;
  realtime: RealtimePublisher;
  logger: MinimalLogger;
  recordings?: RecordingChunkCountRepository;
  chunkFileObjects?: ChunkFileObjectRepository;
  limits?: Partial<MediaLimits>;
  segmentSeconds?: number;
  tmpRoot?: string;
  defaultSttProviderId?: TranscriptionJobPayload['sttProviderId'];
  now?: () => Date;
};

export type JobContext = { jobId?: string | undefined; isFinalAttempt: boolean };

export class MediaJobError extends Error {
  override readonly name = 'MediaJobError';
  constructor(
    readonly errorCode: string,
    message: string
  ) {
    super(message);
  }
}

export function errorCodeOf(err: unknown): string {
  if (err instanceof MediaJobError) return err.errorCode;
  if (err instanceof StorageError) return err.code === 'NOT_FOUND' ? 'source_not_found' : err.code === 'FORBIDDEN' ? 'forbidden' : 'storage_error';
  if ((err as { name?: string })?.name === 'FfmpegError') return 'media_processing_failed';
  return 'internal_error';
}

async function sha256File(p: string): Promise<string> {
  const h = createHash('sha256');
  for await (const c of createReadStream(p)) h.update(c as Buffer);
  return h.digest('hex');
}

/** Counts bytes while streaming and aborts past the cap (defends against HEAD/GET size races). */
function byteCap(max: number): Transform {
  let n = 0;
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length;
      if (n > max) return cb(new MediaJobError('source_too_large', 'Source exceeds size limit'));
      cb(null, chunk);
    }
  });
}

/**
 * Process one recording: validate the contract payload, verify ownership, HEAD-check size, download,
 * probe with a forced allowlisted demuxer, normalize (16 kHz mono, -t/-fs capped), chunk, upload,
 * enqueue one transcription job per chunk (chunkIndex + startMs), and publish progress.
 * Deterministic keys/ids make retries safe. The temp dir is always removed.
 */
export async function processRecording(
  payload: MediaJobPayload,
  deps: MediaProcessorDeps,
  ctx: JobContext = { isFinalAttempt: true }
): Promise<MediaProcessingResult> {
  if (!Value.Check(MediaJobSchema, payload)) throw new MediaJobError('invalid_payload', 'Invalid media job payload');
  const { organizationId, meetingId, recordingId } = payload;
  const limits: MediaLimits = { ...DEFAULT_MEDIA_LIMITS, ...deps.limits };
  const now = deps.now ?? (() => new Date());
  const log = { organizationId, meetingId, recordingId, jobId: ctx.jobId };
  const segmentSeconds = deps.segmentSeconds ?? 600;
  const progress = (percent: number, stage: TranscriptionStage, extra: Partial<TranscriptionProgressEvent> = {}) =>
    deps.realtime.transcriptionProgress({ organizationId, meetingId, recordingId, percent, stage, at: now().toISOString(), ...extra });

  const sourceRef: MeetingObjectRef = { organizationId, meetingId, kind: 'recording', objectId: recordingId, ext: payload.sourceExt };
  let demuxer: AllowedDemuxer;
  let source: { organizationId: string; meetingId: string; key: string };
  try {
    // Read the source through its stored key when given (it may be a legacy org/ key); otherwise the derived key.
    // Never rebuild a different path for an existing object. Owner + exact shape are enforced under either prefix.
    const key = payload.sourceKey ?? buildObjectKey(sourceRef);
    assertKeyOwnedBy(key, organizationId, meetingId);
    if (parseMeetingKey(key)?.rest !== `recordings/${recordingId}.${payload.sourceExt}`) {
      throw new MediaJobError('forbidden', 'sourceKey does not match recording');
    }
    source = { organizationId, meetingId, key };
    demuxer = demuxerForExt(payload.sourceExt);
  } catch (err) {
    deps.logger.warn({ ...log, errorCode: errorCodeOf(err) }, 'media job rejected');
    throw err;
  }

  let tmp: string | undefined;
  try {
    deps.realtime.meetingStatus({ organizationId, meetingId, status: 'processing', at: now().toISOString() });
    deps.logger.info(log, 'media job started');

    const head = await deps.storage.headObjectByKey(source);
    if (!head) throw new MediaJobError('source_not_found', 'Source not found');
    if (head.sizeBytes < 1 || head.sizeBytes > limits.maxSourceBytes) throw new MediaJobError('source_too_large', 'Source exceeds size limit');

    tmp = await mkdtemp(path.join(deps.tmpRoot ?? tmpdir(), 'meetops-media-'));
    const srcPath = path.join(tmp, `source.${payload.sourceExt}`);
    const { body } = await deps.storage.getObjectByKey(source);
    await pipeline(body, byteCap(limits.maxSourceBytes), createWriteStream(srcPath));

    const info = await deps.media.probeMedia(srcPath, { format: demuxer });
    assertProbedFormat(info, demuxer);
    if (!info.hasAudio) throw new MediaJobError('no_audio_stream', 'Recording has no audio stream');
    if (!(info.durationSeconds > 0) || info.durationSeconds > limits.maxDurationSeconds) {
      throw new MediaJobError('source_too_long', 'Recording exceeds duration limit');
    }
    progress(5, 'normalizing');

    const wavPath = await deps.media.normalizeToWav(srcPath, path.join(tmp, 'normalized.wav'), {
      inputFormat: demuxer,
      maxDurationSeconds: limits.maxDurationSeconds,
      maxOutputBytes: normalizedByteCap(limits.maxDurationSeconds),
      maxInputBytes: limits.maxSourceBytes
    });
    const wavSize = (await stat(wavPath)).size;
    const normalizedRef: MeetingObjectRef = { organizationId, meetingId, kind: 'normalized', objectId: recordingId };
    await deps.storage.putObject(normalizedRef, createReadStream(wavPath), { mimeType: 'audio/wav', sizeBytes: wavSize });
    progress(30, 'chunking');

    const chunks = await deps.media.chunkAudio(wavPath, path.join(tmp, 'chunks'), { segmentSeconds });
    if (chunks.length === 0) throw new MediaJobError('no_chunks', 'Chunking produced no output');

    const manifest: ChunkManifestEntry[] = [];
    const rows: ChunkFileObjectRow[] = [];
    for (const [i, c] of chunks.entries()) {
      const size = (await stat(c.path)).size;
      const chunkRef: MeetingObjectRef = { organizationId, meetingId, kind: 'chunk', objectId: recordingId, index: c.index };
      await deps.storage.putObject(chunkRef, createReadStream(c.path), { mimeType: 'audio/wav', sizeBytes: size });
      if (deps.chunkFileObjects) {
        rows.push({
          fileObjectId: chunkFileObjectId(recordingId, c.index),
          index: c.index,
          storageKey: buildObjectKey(chunkRef),
          sizeBytes: size,
          mimeType: 'audio/wav',
          sha256: await sha256File(c.path),
          startMs: Math.round(c.startSeconds * 1000),
          durationMs: Math.round(c.durationSeconds * 1000)
        });
      }
      manifest.push({
        index: c.index,
        fileObjectId: chunkFileObjectId(recordingId, c.index),
        startMs: Math.round(c.startSeconds * 1000),
        durationMs: Math.round(c.durationSeconds * 1000),
        sizeBytes: size,
        transcriptionJobId: transcriptionJobId(organizationId, recordingId, c.index)
      });
      progress(30 + Math.round(((i + 1) / chunks.length) * 50), 'chunking', { chunksDone: i + 1, chunksTotal: chunks.length });
    }

    // Chunk FileObject rows first (the audio resolver needs them), then the count, then jobs. Any failure here
    // enqueues nothing; a retry upserts the same deterministic ids and keys.
    if (deps.chunkFileObjects) {
      try {
        await deps.chunkFileObjects.upsertChunkFileObjects({ organizationId, meetingId, recordingId, chunks: rows });
      } catch {
        throw new MediaJobError('chunk_file_objects_persist_failed', 'Could not persist chunk file objects');
      }
    }

    // Persist the expected chunk count before any transcription job exists, so AI can compute percent/complete.
    if (deps.recordings) {
      try {
        await deps.recordings.setChunkCount({ organizationId, meetingId, recordingId, chunkCount: manifest.length });
      } catch {
        throw new MediaJobError('chunk_count_persist_failed', 'Could not persist chunk count');
      }
    }

    for (const m of manifest) {
      const data: TranscriptionJobPayload = {
        jobVersion: 1,
        organizationId,
        idempotencyKey: transcriptionIdempotencyKey(recordingId, m.index),
        kind: 'transcribe_recording',
        meetingId,
        recordingId,
        fileObjectId: m.fileObjectId,
        chunkIndex: m.index,
        startMs: m.startMs,
        sttProviderId: payload.sttProviderId ?? deps.defaultSttProviderId ?? 'assemblyai',
        diarize: true,
        ...(payload.languageHint ? { languageHint: payload.languageHint } : {}),
        ...(payload.requestId ? { requestId: payload.requestId } : {})
      };
      if (!Value.Check(TranscriptionJobSchema, data)) throw new MediaJobError('invalid_transcription_payload', 'Transcription payload failed contract check');
      await deps.transcriptionQueue.add(QUEUE_NAMES.transcription, data, { jobId: m.transcriptionJobId });
    }
    progress(85, 'transcribing', { chunksDone: 0, chunksTotal: manifest.length });
    deps.logger.info({ ...log, chunks: manifest.length }, 'media job completed');

    return {
      recordingId,
      durationMs: Math.round(info.durationSeconds * 1000),
      formatName: info.formatName,
      normalized: { fileObjectId: normalizedFileObjectId(recordingId), sizeBytes: wavSize },
      chunks: manifest
    };
  } catch (err) {
    const errorCode = errorCodeOf(err);
    deps.logger.error({ ...log, errorCode, finalAttempt: ctx.isFinalAttempt }, 'media job failed');
    if (ctx.isFinalAttempt) {
      deps.realtime.meetingStatus({ organizationId, meetingId, status: 'failed', errorCode, at: now().toISOString() });
    }
    throw err;
  } finally {
    if (tmp) await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}
