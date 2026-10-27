import { AsyncLocalStorage } from 'node:async_hooks';
import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { chunkAudio, computeWaveform, normalizeToWav, probeMedia } from '@meetops/media-core';
import { disconnectPrismaClient } from '@meetops/database';
import {
  loadStorageConfig,
  refOrganizationId,
  S3StorageService,
  StorageAccessError,
  type AuthorizeTarget,
} from '@meetops/storage';
import { MEDIA_JOB_NAMES, QUEUE_NAMES, type SttProviderId } from '@meetops/contracts';
import { logger as baseLogger } from '../logger.js';
import {
  DEFAULT_MEDIA_LIMITS,
  DEFAULT_WORK_TMP_BYTES,
  peakScratchBytes,
  processRecording,
  type MediaProcessorDeps,
  type MinimalLogger,
  type RealtimePublisher,
  type TranscriptionEnqueuer,
  type WaveformOps,
} from './processor.js';
import {
  assertMediaWorkerDatabaseEnv,
  createMediaPersistence,
  type MediaPersistence,
} from './persistence.js';
import { createRealtimePublisher, createRedisEmitter } from './realtime.js';
import { assembleRecordingSession, type SessionAssemblyDeps } from './assemble-session.js';
import {
  createProcessingFailureOutbox,
  createSessionAssemblyStore,
} from './session-assembly-store.js';
import { MEDIA_QUEUE, type MediaJobPayload, type TranscriptionJobPayload } from './types.js';

export type MediaWorkerConfig = {
  redisUrl: string;
  concurrency: number;
  segmentSeconds: number;
  tmpRoot?: string;
  sttProviderId: SttProviderId;
  maxSourceBytes: number;
  maxDurationSeconds: number;
};

/** Job scope for the storage authorize hook: the worker may only touch its current job's org+meeting. */
const jobScope = new AsyncLocalStorage<{ organizationId: string; meetingId: string }>();

export function workerAuthorize(target: AuthorizeTarget): void {
  const scope = jobScope.getStore();
  // refOrganizationId resolves organizationId (or the deprecated orgId) and throws if they differ.
  if (
    !scope ||
    scope.organizationId !== refOrganizationId(target) ||
    scope.meetingId !== target.meetingId
  )
    throw new StorageAccessError();
}

export function runInJobScope<T>(
  scope: { organizationId: string; meetingId: string },
  fn: () => Promise<T>,
): Promise<T> {
  return jobScope.run(scope, fn);
}

export function loadMediaWorkerConfig(env: NodeJS.ProcessEnv = process.env): MediaWorkerConfig {
  const int = (name: string, def: number, min: number, max: number) => {
    const v = env[name];
    if (!v) return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max)
      throw new Error(`${name} must be an integer in ${min}..${max}`);
    return n;
  };
  const stt = (env.STT_PROVIDER_ID ?? 'assemblyai') as SttProviderId;
  if (!['assemblyai', 'faster-whisper', 'deepgram'].includes(stt))
    throw new Error('Invalid STT_PROVIDER_ID');
  const cfg: MediaWorkerConfig = {
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    concurrency: int('MEDIA_WORKER_CONCURRENCY', 1, 1, 16),
    segmentSeconds: int('MEDIA_CHUNK_SECONDS', 600, 10, 3600),
    sttProviderId: stt,
    maxSourceBytes: int(
      'MEDIA_MAX_SOURCE_BYTES',
      DEFAULT_MEDIA_LIMITS.maxSourceBytes,
      1,
      DEFAULT_MEDIA_LIMITS.maxSourceBytes,
    ),
    maxDurationSeconds: int(
      'MEDIA_MAX_DURATION_SECONDS',
      DEFAULT_MEDIA_LIMITS.maxDurationSeconds,
      1,
      24 * 60 * 60,
    ),
  };
  if (env.MEDIA_TMP_DIR) cfg.tmpRoot = env.MEDIA_TMP_DIR;
  // Fail fast if one job (x concurrency) could overflow the scratch tmpfs.
  const tmpBytes = int('MEDIA_WORK_TMP_BYTES', DEFAULT_WORK_TMP_BYTES, 1, Number.MAX_SAFE_INTEGER);
  const peak =
    peakScratchBytes({
      maxSourceBytes: cfg.maxSourceBytes,
      maxDurationSeconds: cfg.maxDurationSeconds,
    }) * cfg.concurrency;
  if (peak > tmpBytes)
    throw new Error(`Media limits need ${peak} B scratch but MEDIA_WORK_TMP_BYTES is ${tmpBytes}`);
  return cfg;
}

export type MediaWorkerParts = {
  storage: MediaProcessorDeps['storage'] & { putDerivedJson: WaveformOps['store'] };
  transcriptionQueue: TranscriptionEnqueuer;
  realtime: RealtimePublisher;
  logger: MinimalLogger;
  /**
   * Recording ownership check (before any upload) and the atomic chunk rows + recordings.chunk_count write (#92).
   * Required: production must verify and persist both.
   */
  persistence: Pick<MediaPersistence, 'recordingAccess' | 'chunks'>;
};

/**
 * The processor deps startMediaWorker runs with: ffmpeg ops, #88 waveform step, #90 realtime publisher and the #92
 * persistence steps: verify the recording belongs to the job's organization/meeting before any upload, then write chunk
 * FileObject rows + recordings.chunk_count in one runWithOrganizationContext transaction.
 */
export function buildMediaProcessorDeps(
  cfg: MediaWorkerConfig,
  parts: MediaWorkerParts,
): MediaProcessorDeps {
  const { storage } = parts;
  return {
    storage,
    waveform: {
      compute: (p, o) => computeWaveform(p, o),
      store: (ref, w) => storage.putDerivedJson(ref, w),
    },
    media: {
      probeMedia: (p, o) => probeMedia(p, o),
      normalizeToWav: (i, o, x) => normalizeToWav(i, o, x),
      chunkAudio: (i, o, x) => chunkAudio(i, o, x),
    },
    limits: { maxSourceBytes: cfg.maxSourceBytes, maxDurationSeconds: cfg.maxDurationSeconds },
    transcriptionQueue: parts.transcriptionQueue,
    realtime: parts.realtime,
    logger: parts.logger,
    recordingVerifier: parts.persistence.recordingAccess,
    chunkPersistence: parts.persistence.chunks,
    segmentSeconds: cfg.segmentSeconds,
    defaultSttProviderId: cfg.sttProviderId,
    ...(cfg.tmpRoot ? { tmpRoot: cfg.tmpRoot } : {}),
  };
}

/** Wire the BullMQ media worker with real storage, ffmpeg, Postgres persistence, transcription queue and Redis emitter. */
export function startMediaWorker(cfg: MediaWorkerConfig = loadMediaWorkerConfig()) {
  assertMediaWorkerDatabaseEnv(process.env);
  const logger = baseLogger.child({ worker: MEDIA_QUEUE });
  const conn = () => new Redis(cfg.redisUrl, { maxRetriesPerRequest: null });
  const emitterRedis = conn();
  const transcriptionQueue = new Queue<TranscriptionJobPayload>(QUEUE_NAMES.transcription, {
    connection: conn(),
  });
  const storageConfig = loadStorageConfig(process.env);
  const storage = new S3StorageService({ config: storageConfig, authorize: workerAuthorize });
  // Shared Prisma client (DATABASE_URL, the NOBYPASSRLS app role); every write runs in runWithOrganizationContext.
  const persistence = createMediaPersistence({
    bucket: storageConfig.bucket,
    provider: storageConfig.provider,
  });
  const deps = buildMediaProcessorDeps(cfg, {
    storage,
    transcriptionQueue: { add: (name, data, opts) => transcriptionQueue.add(name, data, opts) },
    realtime: createRealtimePublisher(createRedisEmitter(emitterRedis)),
    logger,
    persistence,
  });
  const failureOutbox = createProcessingFailureOutbox();
  const mediaQueue = new Queue<MediaJobPayload>(MEDIA_QUEUE, { connection: conn() });
  const assemblyDeps: SessionAssemblyDeps = {
    store: createSessionAssemblyStore({
      bucket: storageConfig.bucket,
      provider: storageConfig.provider,
    }),
    storage,
    mediaQueue: { add: (name, data, opts) => mediaQueue.add(name, data, opts) },
    realtime: deps.realtime,
    logger,
  };
  const worker = new Worker<unknown, unknown>(
    MEDIA_QUEUE,
    (job: Job<unknown>) => dispatchMediaJob(job, { ...deps, failureOutbox }, assemblyDeps),
    { connection: conn(), concurrency: cfg.concurrency },
  );
  worker.on('failed', (job) => logger.warn({ jobId: job?.id }, 'media job attempt failed'));
  const close = async () => {
    await Promise.allSettled([worker.close(), transcriptionQueue.close(), mediaQueue.close()]);
    emitterRedis.disconnect();
    await disconnectPrismaClient().catch(() => undefined);
  };
  return { worker, close };
}

const scopeOf = (data: unknown) => {
  const d = (data ?? {}) as { organizationId?: unknown; meetingId?: unknown };
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return { organizationId: str(d.organizationId), meetingId: str(d.meetingId) };
};

/**
 * Routes a MEDIA_QUEUE job by name (= payload kind, ADR-014). Each handler validates its payload against contracts and
 * runs inside the org+meeting job scope the storage authorize hook checks.
 * - process_recording: normalize, chunk, transcribe.
 * - assemble_recording_session: concatenate session chunks, then enqueue process_recording.
 * - process_upload: not wired here yet (upload keys are not meeting-scoped); fails without retry so the upload stays
 *   scanStatus=pending (fail closed).
 */
export async function dispatchMediaJob(
  job: Pick<Job<unknown>, 'name' | 'data' | 'id' | 'attemptsMade' | 'opts'>,
  deps: MediaProcessorDeps,
  assembly: SessionAssemblyDeps,
): Promise<unknown> {
  const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  switch (job.name) {
    case MEDIA_JOB_NAMES.processRecording:
      return runInJobScope(scopeOf(job.data), () =>
        processRecording(job.data as MediaJobPayload, deps, { jobId: job.id, isFinalAttempt }),
      );
    case MEDIA_JOB_NAMES.assembleRecordingSession:
      return runInJobScope(scopeOf(job.data), () =>
        assembleRecordingSession(job.data, assembly, { isFinalAttempt }),
      );
    case MEDIA_JOB_NAMES.processUpload:
      throw new UnrecoverableError('process_upload is not wired in the media worker yet');
    default:
      throw new UnrecoverableError('Unknown media job');
  }
}
