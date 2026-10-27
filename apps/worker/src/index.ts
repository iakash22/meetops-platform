import { pathToFileURL } from 'node:url';
import { logger } from './logger.js';
import { startMediaWorker } from './media/index.js';
import { registerSummaryWorker, registerTranscriptionWorker } from './ai/index.js';
import { createTranscriptionHostDeps } from './ai/bootstrap.js';
import { loadTranscriptionWorkerEnv } from './ai/env.js';
import { createQueue, createWorker } from '@meetops/queue';
import { getPrismaClient, purgeExpiredSessions, redactExpiredIpAddresses } from '@meetops/database';
import { IP_RETENTION_QUEUE, runIpRetention, scheduleIpRetention } from './privacy/index.js';
import {
  GEOIP_UPDATE_QUEUE,
  loadMmdbUpdaterConfig,
  runMmdbUpdate,
  scheduleMmdbUpdate,
} from './geoip/mmdb-updater.js';

export * from './media/index.js';
export * from './ai/index.js';
export * from './integrations/index.js';
export * from './privacy/index.js';
export * from './geoip/mmdb-updater.js';

async function main() {
  const { close } = startMediaWorker();
  logger.info('media worker started');
  // Flag-gated: deps (Prisma repository, ai-core executor, chunk audio) are only built when the worker is enabled.
  const env = loadTranscriptionWorkerEnv();
  const hostDeps = env.enabled ? await createTranscriptionHostDeps() : undefined;
  const transcription = registerTranscriptionWorker({ env, resolveDeps: () => hostDeps });
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
  const shutdown = async () => {
    logger.info('Shutting down worker...');
    await Promise.allSettled([
      close(),
      transcription.registered ? transcription.close() : Promise.resolve(),
      summary.registered ? summary.close() : Promise.resolve(),
      retention ? retention.close() : Promise.resolve(),
      geoipUpdate ? geoipUpdate.close() : Promise.resolve(),
    ]);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    logger.error({ err }, 'Worker failed to start');
    process.exit(1);
  });
}
