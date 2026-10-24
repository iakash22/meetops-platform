import { pathToFileURL } from 'node:url';
import { logger } from '@meetops/logger';
import { startMediaWorker } from './media/index.js';

export * from './media/index.js';
export * from './ai/index.js';

async function main() {
  const { close } = startMediaWorker();
  logger.info('media worker started');
  const shutdown = async () => {
    logger.info('Shutting down worker...');
    await close();
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
