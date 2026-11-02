import { pathToFileURL } from 'node:url';
import { logger } from './logger.js';
import { startMediaWorker } from './media/index.js';
import { registerSummaryWorker, registerTranscriptionWorker } from './ai/index.js';
import { createTranscriptionHostDeps } from './ai/bootstrap.js';
import { loadTranscriptionWorkerEnv } from './ai/env.js';
import { Redis } from 'ioredis';
import { createPrismaClient } from '@meetops/database';
import { createNotificationDeliveryProducer } from '@meetops/notifications';
import { createRedisEmitter } from './media/realtime.js';
import { loadNotificationsWorkerEnv, registerNotificationsWorker } from './notifications/index.js';
import { createQueue, createWorker } from '@meetops/queue';
import { getPrismaClient, purgeExpiredSessions, redactExpiredIpAddresses } from '@meetops/database';
import { IP_RETENTION_QUEUE, runIpRetention, scheduleIpRetention } from './privacy/index.js';
import {
  GEOIP_UPDATE_QUEUE,
  loadMmdbUpdaterConfig,
  runMmdbUpdate,
  scheduleMmdbUpdate,
} from './geoip/mmdb-updater.js';
import { createNotificationEmailSender } from './notifications/email.js';
import { loadCalendarSyncEnv, registerCalendarSyncScheduler } from './calendar/index.js';
import { loadTokenRefreshEnv, registerTokenRefreshJob } from './integrations/bootstrap.js';
import { loadTaskSyncEnv, registerTaskSyncWorker } from './integrations/task-sync-bootstrap.js';
import { closeAll, runningJobs, type ClosableJob } from './shutdown.js';

export * from './media/index.js';
export * from './ai/index.js';
export * from './integrations/index.js';
export * from './notifications/index.js';
export * from './privacy/index.js';
export * from './geoip/mmdb-updater.js';
export * from './shutdown.js';

/** Process entry. Tests call `main()`; the dev CLI (`src/run.ts`) calls the `boot` alias. */
export async function main() {
  console.log('[worker] loading…');
  const { close } = startMediaWorker();
  logger.info('media worker started');
  console.log('[worker] media worker started');
  // Flag-gated: deps (Prisma repository, ai-core executor, chunk audio) are only built when the worker is enabled.
  const env = loadTranscriptionWorkerEnv();
  const hostDeps = env.enabled ? await createTranscriptionHostDeps() : undefined;
  const transcription = registerTranscriptionWorker({ env, resolveDeps: () => hostDeps });
  // ADR-013 outbox relay + delivery. Relay claims run as meetops_relay (definer functions only); no push token
  // cipher is wired yet, so push channels are skipped until one is injected.
  const notifEnv = loadNotificationsWorkerEnv();
  const relayUrl = process.env.DATABASE_RELAY_URL?.trim();
  const notifRedis = notifEnv.enabled
    ? new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: null })
    : undefined;
  const notifications = registerNotificationsWorker({
    env: notifEnv,
    relayClient:
      notifEnv.enabled && relayUrl ? createPrismaClient({ databaseUrl: relayUrl }) : undefined,
    producer: notifEnv.enabled
      ? createNotificationDeliveryProducer()
      : { enqueue: async () => undefined },
    emitter: notifRedis ? createRedisEmitter(notifRedis) : undefined,
    expoAccessToken: process.env.EXPO_ACCESS_TOKEN?.trim() || undefined,
    email: notifEnv.enabled ? createNotificationEmailSender(process.env, logger) : undefined,
  });
  // Consumer of SUMMARY_QUEUE (enqueued by the transcription worker): summary + action items through the same
  // ai-core executor. Flag-gated by AI_SUMMARY_WORKER_ENABLED (default false).
  const summaryEnabled = process.env.AI_SUMMARY_WORKER_ENABLED?.toLowerCase() === 'true';
  const summaryExecutor =
    hostDeps?.executor ??
    (summaryEnabled ? (await createTranscriptionHostDeps()).executor : undefined);
  const summary = registerSummaryWorker({ resolveExecutor: () => summaryExecutor });
  // ADR-014: daily raw-IP retention (on unless IP_RETENTION_ENABLED=false).
  const retention =
    process.env.IP_RETENTION_ENABLED === 'false'
      ? undefined
      : (() => {
          const queue = createQueue(IP_RETENTION_QUEUE);
          const worker = createWorker(IP_RETENTION_QUEUE, () =>
            runIpRetention({
              redact: () => redactExpiredIpAddresses(getPrismaClient()),
              purge: () => purgeExpiredSessions(getPrismaClient()),
              log: logger,
            }),
          );
          void scheduleIpRetention(queue).catch((err: unknown) =>
            logger.warn(
              { errName: err instanceof Error ? err.name : 'unknown' },
              'ip retention schedule failed',
            ),
          );
          return { close: () => Promise.all([worker.close(), queue.close()]) };
        })();
  // ADR-014: monthly GeoIP mmdb update. Off unless GEOIP_UPDATE_URL and GEOIP_DB_PATH are set; a bad URL/host
  // throws here (fail closed at startup).
  const geoipCfg = loadMmdbUpdaterConfig();
  const geoipUpdate = geoipCfg
    ? (() => {
        const queue = createQueue(GEOIP_UPDATE_QUEUE);
        const worker = createWorker(GEOIP_UPDATE_QUEUE, () => runMmdbUpdate(geoipCfg, logger));
        void scheduleMmdbUpdate(queue).catch((err: unknown) =>
          logger.warn(
            { errName: err instanceof Error ? err.name : 'unknown' },
            'geoip update schedule failed',
          ),
        );
        return { close: () => Promise.all([worker.close(), queue.close()]) };
      })()
    : undefined;
  // Integrations token refresh (Jira rotation, GitHub installation tokens). Off unless
  // INTEGRATIONS_TOKEN_REFRESH_ENABLED=true; then INTEGRATIONS_TOKEN_KEK is required (fail closed at startup).
  const tokenRefresh = registerTokenRefreshJob({ env: loadTokenRefreshEnv(), log: logger });
  // Phase 7 calendar background sync (off unless CALENDAR_SYNC_ENABLED=true). One idempotent BullMQ repeatable;
  // an enabled sync with a missing/bad INTEGRATIONS_TOKEN_KEK throws here, as does a bad
  // CALENDAR_SYNC_TICK_MS (fail closed at startup).
  const calendarSync = registerCalendarSyncScheduler({ env: loadCalendarSyncEnv(), log: logger });
  if (calendarSync.registered) {
    await calendarSync.ready;
    logger.info('calendar sync scheduler started');
  }
  // Async task -> GitHub/Jira sync. Off unless TASK_SYNC_ENABLED=true; then INTEGRATIONS_TOKEN_KEK is required.
  const taskSync = await registerTaskSyncWorker({ env: loadTaskSyncEnv(), log: logger });
  const jobs: ClosableJob[] = [
    { name: 'media', close },
    { name: 'transcription', job: transcription },
    { name: 'notifications', job: notifications },
    { name: 'summary', job: summary },
    { name: 'ip-retention', close: retention?.close },
    { name: 'geoip-update', close: geoipUpdate?.close },
    { name: 'integrations-token-refresh', job: tokenRefresh },
    { name: 'calendar-sync', job: calendarSync },
    { name: 'task-sync', job: taskSync },
  ];
  logger.info({ jobs: runningJobs(jobs) }, 'worker jobs registered');
  const shutdown = async () => {
    logger.info('Shutting down worker...');
    await closeAll(jobs, logger);
    notifRedis?.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

/** Alias for `src/run.ts`, which starts the worker without executing `index.ts` as the main module. */
export const boot = main;

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(entry).href;
  } catch {
    return false;
  }
}

if (isDirectRun()) {
  boot().catch((err: unknown) => {
    logger.error({ err }, 'Worker failed to start');
    process.exit(1);
  });
}
