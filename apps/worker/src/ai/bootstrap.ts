import {
  AIExecutor,
  InMemoryIdempotencyStore,
  InMemoryOrgConfigStore,
  InMemoryUsageTracker,
  ModelRouter,
  UsageQuotaManager,
  createCredentialResolver,
  createRegistryFromEnv,
  loadAIEnv,
  type AuditSink,
} from '@meetops/ai-core';
import { loadStorageConfig, S3StorageService } from '@meetops/storage';
import { logger as baseLogger } from '@meetops/logger';
import { createMediaPersistence, createPersistedChunkAudioResolver } from '../media/persistence.js';
import { workerAuthorize } from '../media/worker.js';
import { createPrismaTranscriptRepository } from './prisma-repository.js';
import type { TranscriptionHostDeps } from './worker.js';

export type TranscriptionBootstrapOptions = {
  env?: Record<string, string | undefined>;
  logger?: Pick<typeof baseLogger, 'info' | 'warn' | 'error'>;
};

/**
 * Builds the transcription consumer's host deps from env (Phase 3).
 *
 * - repository: Postgres via `withOrganizationContext` (forced RLS).
 * - executor: providers from ai-core env config. Usage, idempotency and org model config are IN-MEMORY per process
 *   (durable stores are a follow-up); BullMQ jobs are still idempotent through the first-write-wins chunk rows.
 * - credentials: platform env keys only when AI_WORKER_PLATFORM_KEYS=true; org secret refs have no secret manager
 *   yet and resolve to MISSING_CREDENTIALS.
 * - audio: the media worker's persisted chunk objects (same storage authorizer as the media worker).
 * - audit: structured log lines (ids and codes only, never transcript text).
 */
export async function createTranscriptionHostDeps(
  opts: TranscriptionBootstrapOptions = {},
): Promise<TranscriptionHostDeps> {
  const source = opts.env ?? process.env;
  const log = opts.logger ?? baseLogger.child({ component: 'transcription-bootstrap' });
  const { env, errors } = loadAIEnv(source);
  if (errors.length > 0) log.warn({ errors }, 'AI env has invalid values; defaults applied');

  const auditSink: AuditSink = {
    emit: (e) => void log.info({ audit: e }, 'ai provider config audit'),
  };
  const platformKeys = source.AI_WORKER_PLATFORM_KEYS === 'true';
  const resolveCredential = createCredentialResolver(
    { env: (name) => source[name], secret: async () => undefined },
    async () => ({ platformKeys }),
  );
  const registry = await createRegistryFromEnv(env, {
    audit: auditSink,
    resolveCredential,
    system: { system: true, userId: 'system:transcription-worker' },
    production: source.NODE_ENV === 'production',
  });
  const usage = new InMemoryUsageTracker();
  const executor = new AIExecutor({
    registry,
    router: new ModelRouter(env, new InMemoryOrgConfigStore(), auditSink),
    usage,
    quota: new UsageQuotaManager(usage),
    idempotency: new InMemoryIdempotencyStore(),
  });

  const storageConfig = loadStorageConfig(source);
  const storage = new S3StorageService({ config: storageConfig, authorize: workerAuthorize });
  const persistence = createMediaPersistence({
    bucket: storageConfig.bucket,
    provider: storageConfig.provider,
  });
  const audio = createPersistedChunkAudioResolver(storage, persistence);

  return {
    executor,
    repository: createPrismaTranscriptRepository(),
    resolveAudio: (ref) => audio.bytes(ref),
    audit: { record: (entry) => void log.info({ audit: entry }, 'transcription audit') },
  };
}
