import {
  AIExecutor,
  ModelRouter,
  UsageQuotaManager,
  createCredentialResolver,
  createRegistryFromEnv,
  loadAIEnv,
  type AuditSink,
} from '@meetops/ai-core';
import { loadStorageConfig, S3StorageService } from '@meetops/storage';
import { logger as baseLogger } from '../logger.js';
import { createMediaPersistence, createPersistedChunkAudioResolver } from '../media/persistence.js';
import { workerAuthorize } from '../media/worker.js';
import { createPrismaTranscriptRepository } from './prisma-repository.js';
import { createPrismaTranscriptionDelayedStatus } from './transcription-retry.js';
import { createAiStores } from './durable-stores.js';
import type { TranscriptionHostDeps } from './worker.js';

export type TranscriptionBootstrapOptions = {
  env?: Record<string, string | undefined>;
  logger?: Pick<typeof baseLogger, 'info' | 'warn' | 'error'>;
};

/**
 * Builds the transcription consumer's host deps from env (Phase 3).
 *
 * - repository: Postgres via `withOrganizationContext` (forced RLS).
 * - executor: providers from ai-core env config. Usage counters and idempotency are durable in Postgres
 *   (`ai_usage_counters`, `ai_idempotency`, forced RLS) unless AI_STORES=memory (tests only, refused in
 *   production); store errors fail the job, never fall back. Org model config is durable in `ai_org_config`
 *   (ADR-009) via the same AI_STORES switch.
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
  const stores = createAiStores(source);
  if (stores.mode === 'memory')
    log.warn(
      { aiStores: 'memory' },
      'AI usage/idempotency/org-config stores are IN-MEMORY (tests only)',
    );
  const usage = stores.usage;
  const executor = new AIExecutor({
    registry,
    router: new ModelRouter(env, stores.orgConfig, auditSink),
    usage,
    quota: new UsageQuotaManager(usage),
    idempotency: stores.idempotency,
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
    delayedStatus: createPrismaTranscriptionDelayedStatus(),
    resolveAudio: (ref) => audio.bytes(ref),
    audit: { record: (entry) => void log.info({ audit: entry }, 'transcription audit') },
  };
}
