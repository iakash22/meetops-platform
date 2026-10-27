import { pathToFileURL } from 'node:url';
import { logger } from './logger.js';
import { startMediaWorker } from './media/index.js';
import { registerTranscriptionWorker } from './ai/index.js';
import { createTranscriptionHostDeps } from './ai/bootstrap.js';
import { loadTranscriptionWorkerEnv } from './ai/env.js';
import { Redis } from 'ioredis';
import { createPrismaClient } from '@meetops/database';
import { createNotificationDeliveryProducer } from '@meetops/notifications';
import { createRedisEmitter } from './media/realtime.js';
import { loadNotificationsWorkerEnv, registerNotificationsWorker } from './notifications/index.js';

export * from './media/index.js';
export * from './ai/index.js';
export * from './integrations/index.js';
export * from './notifications/index.js';

async function main() {
  const { close } = startMediaWorker();
  logger.info('media worker started');
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
  });
  const shutdown = async () => {
    logger.info('Shutting down worker...');
    await Promise.allSettled([
      close(),
      transcription.registered ? transcription.close() : Promise.resolve(),
      notifications.registered ? notifications.close() : Promise.resolve(),
    ]);
    notifRedis?.disconnect();
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
