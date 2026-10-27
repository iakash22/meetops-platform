import { pathToFileURL } from 'node:url';
import { logger } from './logger.js';
import { startMediaWorker } from './media/index.js';
import { registerSummaryWorker, registerTranscriptionWorker } from './ai/index.js';
import { createTranscriptionHostDeps } from './ai/bootstrap.js';
import { loadTranscriptionWorkerEnv } from './ai/env.js';

export * from './media/index.js';
export * from './ai/index.js';
export * from './integrations/index.js';

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
  const shutdown = async () => {
    logger.info('Shutting down worker...');
    await Promise.allSettled([
      close(),
      transcription.registered ? transcription.close() : Promise.resolve(),
      summary.registered ? summary.close() : Promise.resolve(),
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
