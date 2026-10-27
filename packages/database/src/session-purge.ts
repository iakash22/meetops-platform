import type { PrismaClient } from '@prisma/client';

/**
 * ADR-014 §16: session rows (and their coarse geo, user agent and any remaining IP) are deleted at most this many days
 * after they ended (revoked, or past the absolute expiry). Active sessions are never touched.
 */
export const SESSION_PURGE_DAYS = 90;
export const SESSION_PURGE_BATCH = 1000;
export const SESSION_PURGE_MAX_BATCHES = 1000;

/**
 * Delete sessions that ended more than `days` ago, in batches (SKIP LOCKED) until nothing is left or the batch cap is
 * hit (the next daily run continues). Uses server time (now()). Idempotent. Returns the count only.
 */
export async function purgeExpiredSessions(
  client: Pick<PrismaClient, '$executeRaw'>,
  days: number = SESSION_PURGE_DAYS,
  opts: { batchSize?: number; maxBatches?: number } = {},
): Promise<{ sessionsPurged: number }> {
  if (!Number.isInteger(days) || days < 1 || days > SESSION_PURGE_DAYS) {
    throw new RangeError(`days must be an integer in 1..${SESSION_PURGE_DAYS}`);
  }
  const batch = opts.batchSize ?? SESSION_PURGE_BATCH;
  if (!Number.isInteger(batch) || batch < 1 || batch > 10_000) {
    throw new RangeError('batchSize must be an integer in 1..10000');
  }
  let sessionsPurged = 0;
  for (let i = 0; i < (opts.maxBatches ?? SESSION_PURGE_MAX_BATCHES); i++) {
    const n = await client.$executeRaw`
      DELETE FROM public.sessions WHERE id IN (
        SELECT id FROM public.sessions
        WHERE COALESCE(LEAST(revoked_at, absolute_expires_at), absolute_expires_at)
              < now() - make_interval(days => ${days}::integer)
        ORDER BY absolute_expires_at
        LIMIT ${batch}::integer
        FOR UPDATE SKIP LOCKED)`;
    sessionsPurged += n;
    if (n < batch) break;
  }
  return { sessionsPurged };
}
