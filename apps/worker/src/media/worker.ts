import { AsyncLocalStorage } from 'node:async_hooks';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { chunkAudio, computeWaveform, normalizeToWav, probeMedia } from '@meetops/media-core';
import { createStorageServiceFromEnv, refOrganizationId, StorageAccessError, type AuthorizeTarget } from '@meetops/storage';
import { QUEUE_NAMES, type SttProviderId } from '@meetops/contracts';
import { logger as baseLogger } from '@meetops/logger';
import { DEFAULT_MEDIA_LIMITS, DEFAULT_WORK_TMP_BYTES, peakScratchBytes, processRecording, type MediaProcessorDeps } from './processor.js';
import { createRealtimePublisher, createRedisEmitter } from './realtime.js';
import { MEDIA_QUEUE, type MediaJobPayload, type MediaProcessingResult, type TranscriptionJobPayload } from './types.js';

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
  if (!scope || scope.organizationId !== refOrganizationId(target) || scope.meetingId !== target.meetingId) throw new StorageAccessError();
}

export function runInJobScope<T>(scope: { organizationId: string; meetingId: string }, fn: () => Promise<T>): Promise<T> {
  return jobScope.run(scope, fn);
}

export function loadMediaWorkerConfig(env: NodeJS.ProcessEnv = process.env): MediaWorkerConfig {
  const int = (name: string, def: number, min: number, max: number) => {
    const v = env[name];
    if (!v) return def;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer in ${min}..${max}`);
    return n;
  };
  const stt = (env.STT_PROVIDER_ID ?? 'assemblyai') as SttProviderId;
  if (!['assemblyai', 'faster-whisper', 'deepgram'].includes(stt)) throw new Error('Invalid STT_PROVIDER_ID');
  const cfg: MediaWorkerConfig = {
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379',
    concurrency: int('MEDIA_WORKER_CONCURRENCY', 1, 1, 16),
    segmentSeconds: int('MEDIA_CHUNK_SECONDS', 600, 10, 3600),
    sttProviderId: stt,
    maxSourceBytes: int('MEDIA_MAX_SOURCE_BYTES', DEFAULT_MEDIA_LIMITS.maxSourceBytes, 1, DEFAULT_MEDIA_LIMITS.maxSourceBytes),
    maxDurationSeconds: int('MEDIA_MAX_DURATION_SECONDS', DEFAULT_MEDIA_LIMITS.maxDurationSeconds, 1, 24 * 60 * 60)
  };
  if (env.MEDIA_TMP_DIR) cfg.tmpRoot = env.MEDIA_TMP_DIR;
  // Fail fast if one job (x concurrency) could overflow the scratch tmpfs.
  const tmpBytes = int('MEDIA_WORK_TMP_BYTES', DEFAULT_WORK_TMP_BYTES, 1, Number.MAX_SAFE_INTEGER);
  const peak = peakScratchBytes({ maxSourceBytes: cfg.maxSourceBytes, maxDurationSeconds: cfg.maxDurationSeconds }) * cfg.concurrency;
  if (peak > tmpBytes) throw new Error(`Media limits need ${peak} B scratch but MEDIA_WORK_TMP_BYTES is ${tmpBytes}`);
  return cfg;
}

/** Wire the BullMQ media worker with real storage, ffmpeg, transcription queue and Redis emitter. */
export function startMediaWorker(cfg: MediaWorkerConfig = loadMediaWorkerConfig()) {
  const logger = baseLogger.child({ worker: MEDIA_QUEUE });
  const conn = () => new Redis(cfg.redisUrl, { maxRetriesPerRequest: null });
  const emitterRedis = conn();
  const transcriptionQueue = new Queue<TranscriptionJobPayload>(QUEUE_NAMES.transcription, { connection: conn() });
  const storage = createStorageServiceFromEnv(process.env, { authorize: workerAuthorize });
  const deps: MediaProcessorDeps = {
    storage,
    waveform: { compute: (p, o) => computeWaveform(p, o), store: (ref, w) => storage.putDerivedJson(ref, w) },
    media: { probeMedia: (p, o) => probeMedia(p, o), normalizeToWav: (i, o, x) => normalizeToWav(i, o, x), chunkAudio: (i, o, x) => chunkAudio(i, o, x) },
    limits: { maxSourceBytes: cfg.maxSourceBytes, maxDurationSeconds: cfg.maxDurationSeconds },
    transcriptionQueue: { add: (name, data, opts) => transcriptionQueue.add(name, data, opts) },
    realtime: createRealtimePublisher(createRedisEmitter(emitterRedis)),
    logger,
    segmentSeconds: cfg.segmentSeconds,
    defaultSttProviderId: cfg.sttProviderId,
    ...(cfg.tmpRoot ? { tmpRoot: cfg.tmpRoot } : {})
  };
  const worker = new Worker<MediaJobPayload, MediaProcessingResult>(
    MEDIA_QUEUE,
    (job: Job<MediaJobPayload>) =>
      runInJobScope({ organizationId: job.data.organizationId, meetingId: job.data.meetingId }, () =>
        processRecording(job.data, deps, { jobId: job.id, isFinalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1) })
      ),
    { connection: conn(), concurrency: cfg.concurrency }
  );
  worker.on('failed', (job) => logger.warn({ jobId: job?.id }, 'media job attempt failed'));
  const close = async () => {
    await Promise.allSettled([worker.close(), transcriptionQueue.close()]);
    emitterRedis.disconnect();
  };
  return { worker, close };
}
