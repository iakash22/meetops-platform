import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { logger as baseLogger } from '@meetops/logger';
import type { TranscriptionLogger } from './consumer.js';
import {
  createMeetingSummaryProcessor,
  loadSummaryLimits,
  MeetingSummaryError,
  type MeetingSummaryDeps,
  type MeetingSummaryInput,
  type MeetingSummaryResult,
} from './meeting-summary.js';
import { GeminiLlmProvider, loadGeminiConfig, type GeminiConfig } from './providers/gemini.js';
import type { LlmProvider } from './providers/llm-provider.js';
import { createPrismaSummaryRepository, type SummaryRepository } from './summary-repository.js';
import { SUMMARY_JOB_NAME, SUMMARY_QUEUE } from './summary-trigger.js';

export type SummaryWorkerEnv = { concurrency: number; redisUrl: string };

export class SummaryWorkerEnvError extends Error {}

/** Concurrency defaults to 1 (LLM cost/rate limits); invalid values fail startup with the key name only. */
export function loadSummaryWorkerEnv(env: NodeJS.ProcessEnv = process.env): SummaryWorkerEnv {
  const raw = env.AI_SUMMARY_WORKER_CONCURRENCY?.trim();
  let concurrency = 1;
  if (raw) {
    if (!/^[0-9]{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > 8)
      throw new SummaryWorkerEnvError('AI_SUMMARY_WORKER_CONCURRENCY must be in 1..8');
    concurrency = Number(raw);
  }
  return { concurrency, redisUrl: env.REDIS_URL?.trim() || 'redis://localhost:6379' };
}

type SummaryJob = Pick<Job<MeetingSummaryInput>, 'id' | 'name' | 'data' | 'attemptsMade' | 'opts'>;

/** BullMQ processor for QUEUE_NAMES.ai: only `summarize_meeting` is handled; anything else is permanent. */
export function createSummaryQueueProcessor(deps: MeetingSummaryDeps) {
  const run = createMeetingSummaryProcessor(deps);
  return async (job: SummaryJob): Promise<MeetingSummaryResult> => {
    if (job.name !== SUMMARY_JOB_NAME)
      throw new UnrecoverableError('ai job failed: unsupported_job');
    return run(job);
  };
}

export type SummaryHostDeps = {
  llm: LlmProvider;
  repository: SummaryRepository;
  logger?: TranscriptionLogger;
  limits?: MeetingSummaryDeps['limits'];
};

/** Same pattern as startTranscriptionWorker: one Redis connection per Worker, close() drains in-flight jobs. */
export function startSummaryWorker(cfg: SummaryWorkerEnv, deps: SummaryHostDeps) {
  const logger = deps.logger ?? baseLogger.child({ worker: SUMMARY_QUEUE });
  const worker = new Worker<MeetingSummaryInput, MeetingSummaryResult>(
    SUMMARY_QUEUE,
    createSummaryQueueProcessor({ ...deps, logger }),
    {
      connection: new Redis(cfg.redisUrl, { maxRetriesPerRequest: null }),
      concurrency: cfg.concurrency,
    },
  );
  worker.on('failed', (job, err) =>
    logger.warn(
      { jobId: job?.id, errorCode: err instanceof MeetingSummaryError ? err.code : err?.name },
      'summary job attempt failed',
    ),
  );
  // worker.close() waits for active jobs, then closes the connection BullMQ was given.
  return { worker, close: () => worker.close() };
}

export type RegisterSummaryWorkerOptions = {
  env?: NodeJS.ProcessEnv;
  createLlm?: (cfg: GeminiConfig) => LlmProvider;
  createRepository?: () => SummaryRepository;
  start?: typeof startSummaryWorker;
  logger?: Pick<TranscriptionLogger, 'info' | 'warn'>;
};

export type SummaryRegistration =
  | { registered: true; close: () => Promise<void> }
  | { registered: false; reason: 'llm_not_configured' | 'llm_config_invalid' };

/**
 * Starts the ai-queue consumer only when an LLM provider is configured (GEMINI_API_KEY). Otherwise logs ONE warning
 * (env key names only, never values) and leaves summarize_meeting jobs queued.
 */
export function registerSummaryWorker(
  opts: RegisterSummaryWorkerOptions = {},
): SummaryRegistration {
  const env = opts.env ?? process.env;
  const logger = opts.logger ?? baseLogger;
  let llmCfg: GeminiConfig | undefined;
  try {
    llmCfg = loadGeminiConfig(env);
  } catch {
    logger.warn(
      { worker: SUMMARY_QUEUE, invalid: ['GEMINI_BASE_URL'] },
      'ai summary worker not started: LLM provider config invalid',
    );
    return { registered: false, reason: 'llm_config_invalid' };
  }
  if (!llmCfg) {
    logger.warn(
      { worker: SUMMARY_QUEUE, missing: ['GEMINI_API_KEY'] },
      'ai summary worker not started: LLM provider not configured',
    );
    return { registered: false, reason: 'llm_not_configured' };
  }
  const cfg = loadSummaryWorkerEnv(env);
  const { close } = (opts.start ?? startSummaryWorker)(cfg, {
    llm: (opts.createLlm ?? ((c) => new GeminiLlmProvider(c)))(llmCfg),
    repository: (opts.createRepository ?? (() => createPrismaSummaryRepository()))(),
    limits: loadSummaryLimits(env),
  });
  logger.info({ worker: SUMMARY_QUEUE, concurrency: cfg.concurrency }, 'ai summary worker started');
  return { registered: true, close };
}
