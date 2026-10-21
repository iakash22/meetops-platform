import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { chunkAudio, normalizeToWav, probeMedia } from '@meetops/media-core';
import { createStorageServiceFromEnv } from '@meetops/storage';
import { QUEUE_NAMES, type SttProviderId } from '@meetops/contracts';
import { logger as baseLogger } from '@meetops/logger';
import { processRecording, type MediaProcessorDeps } from './processor.js';
import { createRealtimePublisher, createRedisEmitter } from './realtime.js';
import { MEDIA_QUEUE_NAME, type MediaProcessingJobPayload, type MediaProcessingResult, type TranscriptionJobPayload } from './types.js';

export type MediaWorkerConfig = {
  redisUrl: string;
  concurrency: number;
  segmentSeconds: number;
  tmpRoot?: string;
  sttProviderId: SttProviderId;
};

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
    sttProviderId: stt
  };
  if (env.MEDIA_TMP_DIR) cfg.tmpRoot = env.MEDIA_TMP_DIR;
  return cfg;
}

/** Wire the BullMQ media worker with real storage, ffmpeg, transcription queue and Redis emitter. */
export function startMediaWorker(cfg: MediaWorkerConfig = loadMediaWorkerConfig()) {
  const logger = baseLogger.child({ worker: MEDIA_QUEUE_NAME });
  const conn = () => new Redis(cfg.redisUrl, { maxRetriesPerRequest: null });
  const emitterRedis = conn();
  const transcriptionQueue = new Queue<TranscriptionJobPayload>(QUEUE_NAMES.transcription, { connection: conn() });
  const deps: MediaProcessorDeps = {
    storage: createStorageServiceFromEnv(),
    media: { probeMedia: (p) => probeMedia(p), normalizeToWav: (i, o) => normalizeToWav(i, o), chunkAudio: (i, o, x) => chunkAudio(i, o, x) },
    transcriptionQueue: { add: (name, data, opts) => transcriptionQueue.add(name, data, opts) },
    realtime: createRealtimePublisher(createRedisEmitter(emitterRedis)),
    logger,
    segmentSeconds: cfg.segmentSeconds,
    defaultSttProviderId: cfg.sttProviderId,
    ...(cfg.tmpRoot ? { tmpRoot: cfg.tmpRoot } : {})
  };
  const worker = new Worker<MediaProcessingJobPayload, MediaProcessingResult>(
    MEDIA_QUEUE_NAME,
    (job: Job<MediaProcessingJobPayload>) =>
      processRecording(job.data, deps, { jobId: job.id, isFinalAttempt: job.attemptsMade + 1 >= (job.opts.attempts ?? 1) }),
    { connection: conn(), concurrency: cfg.concurrency }
  );
  worker.on('failed', (job) => logger.warn({ jobId: job?.id }, 'media job attempt failed'));
  const close = async () => {
    await Promise.allSettled([worker.close(), transcriptionQueue.close()]);
    emitterRedis.disconnect();
  };
  return { worker, close };
}
