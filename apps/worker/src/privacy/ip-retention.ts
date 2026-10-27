import type { IpRetentionResult } from '@meetops/database';

/**
 * ADR-014 retention: daily job that nulls raw IPs older than 30 days (sessions, audit events, password resets) and
 * deletes sessions that ended more than 90 days ago (with their coarse geo).
 */
export const IP_RETENTION_QUEUE = 'privacy.ip-retention';
export const IP_RETENTION_SCHEDULER_ID = 'privacy.ip-retention.daily';
/** 03:15 UTC daily. */
export const IP_RETENTION_CRON = '15 3 * * *';

export interface IpRetentionDeps {
  redact: () => Promise<IpRetentionResult>;
  /** ADR-014 §16 session purge (geo retention). */
  purge?: () => Promise<{ sessionsPurged: number }>;
  log: { info(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}

/** One retention pass. Logs counts only (never IPs). Rethrows so BullMQ retries. */
export async function runIpRetention(
  deps: IpRetentionDeps,
): Promise<IpRetentionResult & { sessionsPurged?: number }> {
  try {
    const res = { ...(await deps.redact()), ...(deps.purge ? await deps.purge() : {}) };
    deps.log.info({ ...res }, 'ip retention pass completed');
    return res;
  } catch (err) {
    deps.log.warn(
      { errName: err instanceof Error ? err.name : 'unknown' },
      'ip retention pass failed',
    );
    throw err;
  }
}

/** Minimal BullMQ Queue surface (upsertJobScheduler is idempotent across worker replicas). */
export interface SchedulerQueue {
  upsertJobScheduler(
    id: string,
    repeat: { pattern: string; tz?: string },
    template: { name: string; data?: unknown; opts?: Record<string, unknown> },
  ): Promise<unknown>;
}

export async function scheduleIpRetention(queue: SchedulerQueue): Promise<void> {
  await queue.upsertJobScheduler(
    IP_RETENTION_SCHEDULER_ID,
    { pattern: IP_RETENTION_CRON, tz: 'UTC' },
    {
      name: 'redact',
      data: {},
      opts: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: 30,
        removeOnFail: 100,
      },
    },
  );
}
