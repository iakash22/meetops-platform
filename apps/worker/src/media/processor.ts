import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { TranscriptionJobPayload as TranscriptionJobSchema, QUEUE_NAMES } from '@meetops/contracts';
import type { MeetingStatusEvent, TranscriptionProgressEvent, TranscriptionStage } from '@meetops/contracts';
import { Value } from '@sinclair/typebox/value';
import type { AudioChunk, ProbeResult } from '@meetops/media-core';
import {
  StorageError,
  assertKeyOwnedBy,
  buildObjectKey,
  type MeetingObjectRef,
  type StorageService
} from '@meetops/storage';
import {
  assertId,
  chunkFileObjectId,
  normalizedFileObjectId,
  transcriptionIdempotencyKey,
  transcriptionJobId
} from './ids.js';
import type { ChunkManifestEntry, MediaProcessingJobPayload, MediaProcessingResult, TranscriptionJobPayload } from './types.js';

export type MediaOps = {
  probeMedia(p: string): Promise<ProbeResult>;
  normalizeToWav(input: string, output: string): Promise<string>;
  chunkAudio(input: string, outDir: string, opts: { segmentSeconds: number }): Promise<AudioChunk[]>;
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

export type MediaProcessorDeps = {
  storage: Pick<StorageService, 'getObject' | 'putObject'>;
  media: MediaOps;
  transcriptionQueue: TranscriptionEnqueuer;
  realtime: RealtimePublisher;
  logger: MinimalLogger;
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

function validatePayload(p: MediaProcessingJobPayload): void {
  if (!p || p.jobVersion !== 1 || p.kind !== 'process_recording') throw new MediaJobError('invalid_payload', 'Invalid media job payload');
  try {
    assertId('organizationId', p.organizationId);
    assertId('meetingId', p.meetingId);
    assertId('recordingId', p.recordingId);
    if (!/^[a-z0-9]{1,8}$/.test(p.sourceExt)) throw new Error('Invalid sourceExt');
  } catch (e) {
    throw new MediaJobError('invalid_payload', (e as Error).message);
  }
}

export function errorCodeOf(err: unknown): string {
  if (err instanceof MediaJobError) return err.errorCode;
  if (err instanceof StorageError) return err.code === 'NOT_FOUND' ? 'source_not_found' : err.code === 'FORBIDDEN' ? 'forbidden' : 'storage_error';
  if ((err as { name?: string })?.name === 'FfmpegError') return 'media_processing_failed';
  return 'internal_error';
}

/**
 * Process one recording: verify ownership, download, probe, normalize (16 kHz mono),
 * chunk, upload outputs, enqueue one transcription job per chunk, and publish progress.
 * Deterministic keys/job ids make retries safe. The temp dir is always removed.
 */
export async function processRecording(
  payload: MediaProcessingJobPayload,
  deps: MediaProcessorDeps,
  ctx: JobContext = { isFinalAttempt: true }
): Promise<MediaProcessingResult> {
  validatePayload(payload);
  const { organizationId, meetingId, recordingId } = payload;
  const now = deps.now ?? (() => new Date());
  const log = { organizationId, meetingId, recordingId, jobId: ctx.jobId };
  const segmentSeconds = deps.segmentSeconds ?? 600;

  const progress = (percent: number, stage: TranscriptionStage, extra: Partial<TranscriptionProgressEvent> = {}) =>
    deps.realtime.transcriptionProgress({ organizationId, meetingId, recordingId, percent, stage, at: now().toISOString(), ...extra });

  const sourceRef: MeetingObjectRef = { orgId: organizationId, meetingId, kind: 'recording', objectId: recordingId, ext: payload.sourceExt };
  const expectedKey = buildObjectKey(sourceRef);
  try {
    assertKeyOwnedBy(expectedKey, organizationId);
    if (payload.sourceKey !== undefined) {
      assertKeyOwnedBy(payload.sourceKey, organizationId);
      if (payload.sourceKey !== expectedKey) throw new MediaJobError('forbidden', 'sourceKey does not match recording');
    }
  } catch (err) {
    deps.logger.warn({ ...log, errorCode: errorCodeOf(err) }, 'media job rejected');
    throw err;
  }

  const tmp = await mkdtemp(path.join(deps.tmpRoot ?? tmpdir(), 'meetops-media-'));
  try {
    deps.realtime.meetingStatus({ organizationId, meetingId, status: 'processing', at: now().toISOString() });
    deps.logger.info(log, 'media job started');

    const srcPath = path.join(tmp, `source.${payload.sourceExt}`);
    const { body } = await deps.storage.getObject(sourceRef);
    await pipeline(body, createWriteStream(srcPath));

    const info = await deps.media.probeMedia(srcPath);
    if (!info.hasAudio) throw new MediaJobError('no_audio_stream', 'Recording has no audio stream');
    progress(5, 'normalizing');

    const wavPath = await deps.media.normalizeToWav(srcPath, path.join(tmp, 'normalized.wav'));
    const wavSize = (await stat(wavPath)).size;
    const normalizedRef: MeetingObjectRef = { orgId: organizationId, meetingId, kind: 'normalized', objectId: recordingId };
    await deps.storage.putObject(normalizedRef, createReadStream(wavPath), { mimeType: 'audio/wav', sizeBytes: wavSize });
    progress(30, 'chunking');

    const chunks = await deps.media.chunkAudio(wavPath, path.join(tmp, 'chunks'), { segmentSeconds });
    if (chunks.length === 0) throw new MediaJobError('no_chunks', 'Chunking produced no output');

    const manifest: ChunkManifestEntry[] = [];
    for (const [i, c] of chunks.entries()) {
      const size = (await stat(c.path)).size;
      await deps.storage.putObject(
        { orgId: organizationId, meetingId, kind: 'chunk', objectId: recordingId, index: c.index },
        createReadStream(c.path),
        { mimeType: 'audio/wav', sizeBytes: size }
      );
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

    for (const m of manifest) {
      const data: TranscriptionJobPayload = {
        jobVersion: 1,
        organizationId,
        idempotencyKey: transcriptionIdempotencyKey(recordingId, m.index),
        kind: 'transcribe_recording',
        meetingId,
        recordingId,
        fileObjectId: m.fileObjectId,
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
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}
