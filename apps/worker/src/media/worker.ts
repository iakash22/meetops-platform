import { AsyncLocalStorage } from 'node:async_hooks';
import { Queue, Worker, type Job } from 'bullmq';
import { createAppRedis } from '../redis.js';
import { chunkAudio, computeWaveform, normalizeToWav, probeMedia } from '@meetops/media-core';
import { disconnectPrismaClient } from '@meetops/database';
import {
  loadStorageConfig,
  refOrganizationId,
  S3SessionChunkStore,
  S3StorageService,
  sourceExtForMime,
  StorageAccessError,
  type AuthorizeTarget,
} from '@meetops/storage';
import { QUEUE_NAMES, type SttProviderId } from '@meetops/contracts';
import { logger as baseLogger } from '../logger.js';
import { loadTranscriptionWorkerEnv } from '../ai/env.js';
import type { TranscriptionRetryPolicy } from '../ai/transcription-retry.js';
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
import { createUploadProbe, scanUploadObject, type UploadProbe } from './upload-scan.js';
import {
  processSessionAssembly,
  type SessionAssemblyDeps,
  type SessionAssemblyOutcome,
  type SessionAssemblyStore,
} from './session-assembly.js';
import { createSessionAssemblyStore, sessionObjectsFromStorage } from './session-assembly-store.js';
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
  /** Transcription job attempts/backoff (TRANSCRIPTION_MAX_ATTEMPTS, TRANSCRIPTION_BACKOFF_*). */
  transcriptionRetry?: TranscriptionRetryPolicy | undefined;
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
    transcriptionRetry: loadTranscriptionWorkerEnv(env).retry,
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
    transcriptionRetry: cfg.transcriptionRetry,
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

/**
 * process_recording_session deps: Prisma session store, chunk reader + source writer bound to the job's session and
 * meeting (source writes run inside runInJobScope), the same content scan as uploads (ffprobe + optional clamd from
 * the injected env), then processRecording. Never reads process.env.
 */
export function buildSessionAssemblyDeps(parts: {
  storage: Pick<S3StorageService, 'putObject' | 'headObject' | 'deleteObject' | 'getObject'>;
  chunks: Pick<S3SessionChunkStore, 'readChunk' | 'deleteChunk'>;
  store: SessionAssemblyStore;
  maxSourceBytes: number;
  maxDurationSeconds: number;
  env: Record<string, string | undefined>;
  process: SessionAssemblyDeps['process'];
  probe?: UploadProbe;
  tmpRoot?: string;
}): SessionAssemblyDeps {
  const antivirus = antivirusFromEnv(parts.env);
  const probe = parts.probe ?? createUploadProbe({ maxDurationSeconds: parts.maxDurationSeconds });
  return {
    store: parts.store,
    maxSourceBytes: parts.maxSourceBytes,
    sourceExt: (m) => sourceExtForMime(m),
    objects: (s) => {
      const o = sessionObjectsFromStorage(parts.storage, parts.chunks, s);
      const scoped =
        <A extends unknown[], R>(fn: (...a: A) => Promise<R>) =>
        (...a: A) =>
          runInJobScope({ organizationId: s.organizationId, meetingId: s.meetingId }, () =>
            fn(...a),
          );
      return {
        readChunk: o.readChunk,
        deleteChunk: o.deleteChunk,
        putSource: scoped(o.putSource),
        headSource: scoped(o.headSource),
        deleteSource: scoped(o.deleteSource),
        sourceBody: scoped(o.sourceBody),
      };
    },
    scan: async (source, mime) => {
      const r = await scanUploadObject(source, mime, probe, {
        limits: { maxDurationSeconds: parts.maxDurationSeconds },
        ...(parts.tmpRoot ? { tmpRoot: parts.tmpRoot } : {}),
        ...(antivirus ? { antivirus } : {}),
      });
      return r.verdict === 'clean' ? 'clean' : 'quarantined';
    },
    process: (payload, ctx) =>
      runInJobScope({ organizationId: payload.organizationId, meetingId: payload.meetingId }, () =>
        parts.process(payload, ctx),
      ),
  };
}

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
    session(data: unknown, ctx: { isFinalAttempt: boolean }): Promise<SessionAssemblyOutcome>;
  },
): Promise<MediaProcessingResult | UploadScanOutcome | SessionAssemblyOutcome> {
  const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
  const data = job.data as { kind?: unknown };
  if (data && data.kind === 'process_upload') return handlers.upload(job.data, { isFinalAttempt });
  // API recording-session jobs: assemble the chunks into the recording source, then scan + processRecording.
  if (data && data.kind === 'process_recording_session')
    return handlers.session(job.data, { isFinalAttempt });
  const rec = job.data as MediaJobPayload;
  return runInJobScope({ organizationId: rec.organizationId, meetingId: rec.meetingId }, () =>
    handlers.recording(rec, { ...(job.id ? { jobId: job.id } : {}), isFinalAttempt }),
  );
}

/** Wire the BullMQ media worker with real storage, ffmpeg, Postgres persistence, transcription queue and Redis emitter. */
export function startMediaWorker(
  cfg: MediaWorkerConfig = loadMediaWorkerConfig(),
  env: NodeJS.ProcessEnv = process.env,
) {
  assertMediaWorkerDatabaseEnv(env);
  const logger = baseLogger.child({ worker: MEDIA_QUEUE });
  const conn = () => createAppRedis(cfg.redisUrl, { maxRetriesPerRequest: null });
  const emitterRedis = conn();
  const emitter = createRedisEmitter(emitterRedis);
  const transcriptionQueue = new Queue<TranscriptionJobPayload>(QUEUE_NAMES.transcription, {
    connection: conn(),
  });
  const storageConfig = loadStorageConfig(env);
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
    env,
    ...(cfg.tmpRoot ? { tmpRoot: cfg.tmpRoot } : {}),
  });
  const sessionDeps = buildSessionAssemblyDeps({
    storage,
    chunks: new S3SessionChunkStore({ config: storageConfig }),
    store: createSessionAssemblyStore(),
    maxSourceBytes: cfg.maxSourceBytes,
    maxDurationSeconds: cfg.maxDurationSeconds,
    env,
    process: (payload, ctx) => processRecording(payload, deps, ctx),
    ...(cfg.tmpRoot ? { tmpRoot: cfg.tmpRoot } : {}),
  });
  const worker = new Worker<
    MediaJobPayload,
    MediaProcessingResult | UploadScanOutcome | SessionAssemblyOutcome
  >(
    MEDIA_QUEUE,
    (job: Job<MediaJobPayload>) =>
      dispatchMediaJob(job, {
        recording: (data, ctx) => processRecording(data, deps, ctx),
        upload: (data, ctx) => processUploadScan(data, uploadDeps, ctx),
        session: (data, ctx) => processSessionAssembly(data, sessionDeps, ctx),
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
