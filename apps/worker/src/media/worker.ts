import { AsyncLocalStorage } from 'node:async_hooks';
import { Queue, Worker, type Job } from 'bullmq';
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
import { QUEUE_NAMES, type SttProviderId } from '@meetops/contracts';
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
import {
  createRealtimePublisher,
  createRedisEmitter,
  publishUploadStatus,
  type EmitterLike,
} from './realtime.js';
import {
  processUploadScan,
  type UploadScanDeps,
  type UploadScanOutcome,
} from './upload-scan-job.js';
import {
  createUploadScanStore,
  uploadSourceFromStorage,
  type UploadSourceStorage,
} from './upload-scan-store.js';
import { createUploadProbe } from './upload-scan.js';
import { antivirusFromEnv } from './clamd.js';
import {
  MEDIA_QUEUE,
  type MediaJobPayload,
  type MediaProcessingResult,
  type TranscriptionJobPayload,
} from './types.js';

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

/**
 * process_upload deps (#274 G-1): Prisma store under forced RLS, the upload source object, ffprobe with the duration
 * cap, the optional clamd step (UPLOAD_SCAN_CLAMAV, off by default, fail-closed when on) and realtime upload:status.
 */
export function buildUploadScanDeps(parts: {
  storage: UploadSourceStorage;
  emitter: EmitterLike;
  maxDurationSeconds: number;
  tmpRoot?: string;
  env?: NodeJS.ProcessEnv;
  store?: Pick<UploadScanDeps, 'findUpload' | 'setScanStatus'>;
}): UploadScanDeps {
  const antivirus = antivirusFromEnv(parts.env ?? process.env);
  return {
    ...(parts.store ?? createUploadScanStore()),
    source: uploadSourceFromStorage(parts.storage),
    probe: createUploadProbe({ maxDurationSeconds: parts.maxDurationSeconds }),
    publishUploadStatus: (e) => publishUploadStatus(parts.emitter, e),
    limits: { maxDurationSeconds: parts.maxDurationSeconds },
    ...(parts.tmpRoot ? { tmpRoot: parts.tmpRoot } : {}),
    ...(antivirus ? { antivirus } : {}),
  };
}

export type SessionJobOutcome = { status: 'skipped'; reason: 'session_assembly_pending' };

type DispatchJob = Pick<Job, 'id' | 'attemptsMade' | 'opts'> & { data: unknown };

/**
 * Routes one MEDIA_QUEUE job by kind: `process_upload` goes to the upload scan (the only writer of scanStatus), every
 * other job to processRecording. isFinalAttempt lets the scan quarantine when BullMQ attempts are exhausted.
 */
export function dispatchMediaJob(
  job: DispatchJob,
  handlers: {
    recording(
      data: MediaJobPayload,
      ctx: { jobId?: string; isFinalAttempt: boolean },
    ): Promise<MediaProcessingResult>;
    upload(data: unknown, ctx: { isFinalAttempt: boolean }): Promise<UploadScanOutcome>;
  },
): Promise<MediaProcessingResult | UploadScanOutcome | SessionJobOutcome> {
  const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  const data = job.data as { kind?: unknown };
  if (data && data.kind === 'process_upload') return handlers.upload(job.data, { isFinalAttempt });
  // API recording-session jobs carry no recordingId/fileObjectId and their chunks are not assembled yet: never route
  // them into processRecording (it would fail every attempt). Acknowledged as skipped until session assembly lands.
  if (data && data.kind === 'process_recording_session')
    return Promise.resolve({ status: 'skipped', reason: 'session_assembly_pending' });
  const rec = job.data as MediaJobPayload;
  return runInJobScope({ organizationId: rec.organizationId, meetingId: rec.meetingId }, () =>
    handlers.recording(rec, { ...(job.id ? { jobId: job.id } : {}), isFinalAttempt }),
  );
}

/** Wire the BullMQ media worker with real storage, ffmpeg, Postgres persistence, transcription queue and Redis emitter. */
export function startMediaWorker(cfg: MediaWorkerConfig = loadMediaWorkerConfig()) {
  assertMediaWorkerDatabaseEnv(process.env);
  const logger = baseLogger.child({ worker: MEDIA_QUEUE });
  const conn = () => new Redis(cfg.redisUrl, { maxRetriesPerRequest: null });
  const emitterRedis = conn();
  const emitter = createRedisEmitter(emitterRedis);
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
    realtime: createRealtimePublisher(emitter),
    logger,
    persistence,
  });
  const uploadDeps = buildUploadScanDeps({
    storage,
    emitter,
    maxDurationSeconds: cfg.maxDurationSeconds,
    ...(cfg.tmpRoot ? { tmpRoot: cfg.tmpRoot } : {}),
  });
  const worker = new Worker<
    MediaJobPayload,
    MediaProcessingResult | UploadScanOutcome | SessionJobOutcome
  >(
    MEDIA_QUEUE,
    (job: Job<MediaJobPayload>) =>
      dispatchMediaJob(job, {
        recording: (data, ctx) => processRecording(data, deps, ctx),
        upload: (data, ctx) => processUploadScan(data, uploadDeps, ctx),
      }),
    { connection: conn(), concurrency: cfg.concurrency },
  );
  worker.on('failed', (job) => logger.warn({ jobId: job?.id }, 'media job attempt failed'));
  const close = async () => {
    await Promise.allSettled([worker.close(), transcriptionQueue.close()]);
    emitterRedis.disconnect();
    await disconnectPrismaClient().catch(() => undefined);
  };
  return { worker, close };
}
