import { Redis } from 'ioredis';
import { UnrecoverableError, Worker } from 'bullmq';
import { logger as baseLogger } from '../logger.js';
import { createRedisEmitter, meetingRoom, organizationRoom } from '../media/realtime.js';
import { extractActionItems } from './action-items.js';
import { createPrismaActionItemsRepository } from './action-items-repository.js';
import { createExecutorLlm, type ExecutorLike } from './executor-llm.js';
import {
  SUMMARY_PROMPT_VERSION,
  createMeetingSummaryProcessor,
  loadSummaryLimits,
  type MeetingSummaryDeps,
  type MeetingSummaryInput,
  type SummaryReadyEvent,
} from './meeting-summary.js';
import { createPrismaSummaryRepository } from './summary-repository.js';
import { SUMMARY_JOB_NAME, SUMMARY_QUEUE } from './summary-trigger.js';

export type SummaryWorkerEnv = {
  enabled: boolean;
  actionItemsEnabled: boolean;
  concurrency: number;
  redisUrl: string;
};

const truthy = (v: string | undefined, def: boolean) =>
  v === undefined || v === '' ? def : ['true', '1', 'yes', 'on'].includes(v.toLowerCase());

/** AI_SUMMARY_WORKER_ENABLED (default false), AI_ACTION_ITEMS_ENABLED (default true), AI_SUMMARY_WORKER_CONCURRENCY 1..8. */
export function loadSummaryWorkerEnv(env: NodeJS.ProcessEnv = process.env): SummaryWorkerEnv {
  const c = env.AI_SUMMARY_WORKER_CONCURRENCY;
  const n = c && /^[0-9]{1,2}$/.test(c) ? Number(c) : 1;
  return {
    enabled: truthy(env.AI_SUMMARY_WORKER_ENABLED, false),
    actionItemsEnabled: truthy(env.AI_ACTION_ITEMS_ENABLED, true),
    concurrency: Math.min(8, Math.max(1, n)),
    redisUrl: env.REDIS_URL?.trim() || 'redis://localhost:6379',
  };
}

type EmitterLike = {
  to(room: string | string[]): { emit(event: string, payload: unknown): unknown };
};

/** `summary:ready` to the meeting + org rooms (same rooms as apps/realtime). */
export function createSummaryReadyPublisher(emitter: EmitterLike) {
  return (e: SummaryReadyEvent) => {
    emitter
      .to([meetingRoom(e.organizationId, e.meetingId), organizationRoom(e.organizationId)])
      .emit('summary:ready', e);
  };
}

/**
 * Summary consumer deps: the LLM is the ai-core executor scoped per job organization (feature `summary`), so the
 * provider is chosen by the registry/router (Gemini primary, switchable) with no paid fallback and no
 * caller-supplied endpoints. Action items use the same executor (feature `actions`).
 */
export function createSummaryWorkerDeps(opts: {
  executor: ExecutorLike;
  actionItemsEnabled: boolean;
  logger?: MeetingSummaryDeps['logger'];
  env?: NodeJS.ProcessEnv;
  onSummaryReady?: MeetingSummaryDeps['onSummaryReady'];
}): MeetingSummaryDeps {
  const logger = opts.logger ?? baseLogger.child({ worker: SUMMARY_QUEUE });
  const actionRepo = opts.actionItemsEnabled ? createPrismaActionItemsRepository() : undefined;
  return {
    llmFor: (organizationId, jobId) =>
      createExecutorLlm(opts.executor, {
        organizationId,
        feature: 'summary',
        promptVersion: SUMMARY_PROMPT_VERSION,
        jobId,
      }),
    repository: createPrismaSummaryRepository(),
    logger,
    limits: loadSummaryLimits(opts.env),
    actionItems: actionRepo
      ? {
          extract: (input) =>
            extractActionItems(input, { executor: opts.executor, repository: actionRepo, logger }),
        }
      : undefined,
    onSummaryReady: opts.onSummaryReady,
  };
}

export function startSummaryWorker(
  cfg: { redisUrl: string; concurrency: number },
  deps: MeetingSummaryDeps,
) {
  const conn = () => new Redis(cfg.redisUrl, { maxRetriesPerRequest: null });
  const emitterRedis = deps.onSummaryReady ? undefined : conn();
  const onSummaryReady =
    deps.onSummaryReady ?? createSummaryReadyPublisher(createRedisEmitter(emitterRedis!));
  const process = createMeetingSummaryProcessor({ ...deps, onSummaryReady });
  const worker = new Worker<MeetingSummaryInput>(
    SUMMARY_QUEUE,
    async (job) => {
      if (job.name !== SUMMARY_JOB_NAME) throw new UnrecoverableError('unknown_job');
      return process(job);
    },
    { connection: conn(), concurrency: cfg.concurrency },
  );
  worker.on('failed', (job, err) =>
    deps.logger.warn(
      { jobId: job?.id, errorCode: err?.message?.slice(0, 80) },
      'summary job attempt failed',
    ),
  );
  return {
    worker,
    close: async () => {
      await worker.close();
      emitterRedis?.disconnect();
    },
  };
}

export type SummaryRegistration =
  | { registered: true; close: () => Promise<void> }
  | { registered: false; reason: 'disabled' | 'missing_dependencies' };

/** Registers the SUMMARY_QUEUE consumer only when AI_SUMMARY_WORKER_ENABLED=true and an executor is available. */
export function registerSummaryWorker(opts: {
  env?: SummaryWorkerEnv;
  resolveExecutor?: () => ExecutorLike | undefined;
  start?: typeof startSummaryWorker;
  logger?: Pick<MeetingSummaryDeps['logger'], 'info' | 'warn'>;
  deps?: (executor: ExecutorLike, env: SummaryWorkerEnv) => MeetingSummaryDeps;
}): SummaryRegistration {
  const env = opts.env ?? loadSummaryWorkerEnv();
  const logger = opts.logger ?? baseLogger;
  if (!env.enabled) {
    logger.info(
      { worker: SUMMARY_QUEUE },
      'summary worker disabled (AI_SUMMARY_WORKER_ENABLED=false)',
    );
    return { registered: false, reason: 'disabled' };
  }
  const executor = opts.resolveExecutor?.();
  if (!executor) {
    logger.warn(
      { worker: SUMMARY_QUEUE },
      'summary worker enabled but no AI executor; not registered',
    );
    return { registered: false, reason: 'missing_dependencies' };
  }
  const deps =
    opts.deps?.(executor, env) ??
    createSummaryWorkerDeps({ executor, actionItemsEnabled: env.actionItemsEnabled });
  const { close } = (opts.start ?? startSummaryWorker)(
    { redisUrl: env.redisUrl, concurrency: env.concurrency },
    deps,
  );
  return { registered: true, close };
}
