/**
 * One-shot media job reconciler (#302 M-1). Run from cron / a k8s CronJob:
 *   DATABASE_URL=<meetops_app> REDIS_URL=... node apps/api/dist/scripts/reconcile-media-jobs.js
 * MEDIA_RECONCILE_OLDER_THAN_MS (default 900000 = 15 min) skips subjects whose enqueue may still be in flight.
 * Reads only the env object passed to main(); the process entrypoint passes process.env.
 */
import { pathToFileURL } from 'node:url';
import { createPrismaClient } from '../shared/prisma/context.js';
import { reconcileStaleMedia } from '../modules/media/application/reconcile.js';
import {
  BullMqMediaJobQueue,
  createMediaQueueProducer,
} from '../modules/media/infrastructure/bullmq.js';
import {
  PrismaConsentRepository,
  PrismaStaleMediaStore,
} from '../modules/media/infrastructure/prisma.js';

export async function main(env: Record<string, string | undefined>) {
  if (!env.DATABASE_URL || !env.REDIS_URL) throw new Error('DATABASE_URL and REDIS_URL are required');
  const olderThanMs = Number(env.MEDIA_RECONCILE_OLDER_THAN_MS || 15 * 60_000);
  if (!Number.isInteger(olderThanMs) || olderThanMs < 0) {
    throw new Error('MEDIA_RECONCILE_OLDER_THAN_MS must be a non-negative integer');
  }
  const db = createPrismaClient({ databaseUrl: env.DATABASE_URL });
  const jobs = new BullMqMediaJobQueue(createMediaQueueProducer(env.REDIS_URL));
  try {
    return await reconcileStaleMedia({
      store: new PrismaStaleMediaStore(db),
      consents: new PrismaConsentRepository(db),
      jobs,
      now: () => new Date(),
      olderThanMs,
    });
  } finally {
    await jobs.close();
    await db.$disconnect();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main(process.env).then(
    (r) => process.stdout.write(`${JSON.stringify(r)}\n`),
    (err: unknown) => {
      process.stderr.write(`reconcile failed: ${(err as Error).message}\n`);
      process.exit(1);
    },
  );
}
