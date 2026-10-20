import { createWorker, createQueue } from '@meetops/queue';
import { logger } from '@meetops/logger';

const QUEUE_NAME = 'example';

async function main() {
  const worker = createWorker<{ message: string }, string>(
    QUEUE_NAME,
    async (job: any) => {
      logger.info({ jobId: job.id, data: job.data }, 'processing job');
      return `processed: ${job.data.message}`;
    },
    { concurrency: 2 }
  );

  const queue = createQueue<{ message: string }>(QUEUE_NAME);
  await queue.add('hello', { message: 'Hello from MeetOps AI' });

  const shutdown = async () => {
    logger.info('Shutting down worker...');
    await Promise.allSettled([worker.close(), queue.close()]);
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}

main().catch((err) => {
  logger.error({ err }, 'Worker failed to start');
  process.exit(1);
});
