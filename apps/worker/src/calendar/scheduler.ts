import {
  GoogleCalendarProvider,
  InMemoryOAuthStateStore,
  LocalKeyProvider,
  TokenCipher,
} from '@meetops/integrations';
import { createCalendarSyncRepository } from '@meetops/database';
import { createQueue, createWorker } from '@meetops/queue';
import { parseKek } from '../integrations/bootstrap.js';
import { IntegrationsApiOriginError, integrationsApiOrigin } from '../integrations/api-origin.js';
import {
  CalendarSyncEnvError,
  runCalendarSyncSweep,
  type CalendarSyncDeps,
  type CalendarSyncLog,
  type CalendarSyncProvider,
  type CalendarSyncWorkerEnv,
} from './sync.js';

/**
 * BullMQ wiring for the Phase 7 calendar sweep (runCalendarSyncSweep). One repeatable job, keyed by a fixed
 * scheduler id, fires every CALENDAR_SYNC_TICK_MS (default 60 s). upsertJobScheduler is idempotent per id, so a
 * restart (or a changed interval) updates the one scheduler instead of adding a second repeatable. The worker runs
 * with concurrency 1 and BullMQ hands each job to one consumer, but sweeps CAN still overlap across replicas: the
 * next run is queued as a sweep starts, and a stalled job whose lock expires can run alongside it. Overlap is safe
 * because each connection is claimed with a DB lease (claimForSync moves next_sync_at forward atomically), and
 * the writes after the provider call only land while that lease is still held. The per-connection cadence
 * (CALENDAR_SYNC_INTERVAL_MS) is enforced by nextSyncAt inside the sweep.
 */
export const CALENDAR_SYNC_QUEUE = 'calendar.sync';
export const CALENDAR_SYNC_SCHEDULER_ID = 'calendar.sync.sweep';

export interface CalendarSyncSchedulerQueue {
  upsertJobScheduler(
    id: string,
    repeat: { every: number },
    template: { name: string; data?: unknown; opts?: Record<string, unknown> },
  ): Promise<unknown>;
  close(): Promise<void>;
}

export interface CalendarSyncSchedulerWorker {
  close(): Promise<void>;
}

export async function scheduleCalendarSync(
  queue: Pick<CalendarSyncSchedulerQueue, 'upsertJobScheduler'>,
  everyMs: number,
): Promise<void> {
  await queue.upsertJobScheduler(
    CALENDAR_SYNC_SCHEDULER_ID,
    { every: everyMs },
    {
      name: 'sweep',
      data: {},
      // No BullMQ retries: a failed sweep is simply re-run on the next tick (per-connection backoff is in the sweep).
      opts: { attempts: 1, removeOnComplete: 20, removeOnFail: 100 },
    },
  );
}

/** INTEGRATIONS_API_ORIGIN for the Google redirect URI: required (https, no default) under NODE_ENV=production. */
function calendarApiOrigin(env: NodeJS.ProcessEnv): string {
  try {
    return integrationsApiOrigin(env);
  } catch (err) {
    if (err instanceof IntegrationsApiOriginError) throw new CalendarSyncEnvError(err.message);
    throw err;
  }
}

/** Google only for now; the provider is skipped (connections left untouched) when its OAuth client is unset. */
export function calendarSyncProvidersFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Partial<Record<string, CalendarSyncProvider>> {
  const clientId = env.GOOGLE_CALENDAR_CLIENT_ID?.trim();
  const secret = env.GOOGLE_CALENDAR_CLIENT_SECRET;
  if (!clientId || !secret) return {};
  const apiOrigin = calendarApiOrigin(env);
  return {
    google: new GoogleCalendarProvider({
      clientId,
      clientSecret: async () => secret,
      redirectUriAllowlist: [`${apiOrigin}/calendar/google/callback`],
      stateStore: new InMemoryOAuthStateStore(),
    }),
  };
}

export type CalendarSyncSchedulerRegistration =
  | { registered: false; reason: 'disabled' }
  | { registered: true; ready: Promise<void>; close: () => Promise<void> };

export interface RegisterCalendarSyncSchedulerOptions {
  env: CalendarSyncWorkerEnv;
  log: CalendarSyncLog;
  processEnv?: NodeJS.ProcessEnv;
  /** Test seams; default to the Prisma repository + env providers and @meetops/queue. */
  buildDeps?: (kek: Buffer) => Omit<CalendarSyncDeps, 'log' | 'config'>;
  createQueue?: (name: string) => CalendarSyncSchedulerQueue;
  createWorker?: (
    name: string,
    processor: () => Promise<unknown>,
    opts: { concurrency: number },
  ) => CalendarSyncSchedulerWorker;
}

/**
 * Calendar sync scheduler for apps/worker main(). Off unless CALENDAR_SYNC_ENABLED=true. When on, the shared KEK
 * (INTEGRATIONS_TOKEN_KEK) must be valid or startup fails closed: the worker cannot decrypt API-sealed tokens.
 */
export function registerCalendarSyncScheduler(
  opts: RegisterCalendarSyncSchedulerOptions,
): CalendarSyncSchedulerRegistration {
  if (!opts.env.enabled) return { registered: false, reason: 'disabled' };
  const processEnv = opts.processEnv ?? process.env;
  const kek = parseKek(processEnv);
  if (!kek)
    throw new CalendarSyncEnvError(
      'INTEGRATIONS_TOKEN_KEK must be 32 bytes (base64) when CALENDAR_SYNC_ENABLED=true',
    );
  // Validated up front (not only when the default providers are built) so a bad origin fails startup.
  if (processEnv.GOOGLE_CALENDAR_CLIENT_ID?.trim()) calendarApiOrigin(processEnv);
  const base =
    opts.buildDeps?.(kek) ??
    ({
      repo: createCalendarSyncRepository({
        cipher: new TokenCipher(new LocalKeyProvider({ shared: kek }, 'shared')),
      }),
      providers: calendarSyncProvidersFromEnv(processEnv),
    } satisfies Omit<CalendarSyncDeps, 'log' | 'config'>);
  const deps: CalendarSyncDeps = { ...base, log: opts.log, config: opts.env.config };
  const queue = (opts.createQueue ?? ((n: string) => createQueue(n)))(CALENDAR_SYNC_QUEUE);
  const worker = (
    opts.createWorker ??
    ((n: string, p: () => Promise<unknown>, o: { concurrency: number }) => createWorker(n, p, o))
  )(CALENDAR_SYNC_QUEUE, () => runCalendarSyncSweep(deps), { concurrency: 1 });
  // Rejects on a scheduling failure (e.g. Redis down): main() awaits it, so startup fails instead of running a
  // worker that never gets a job.
  const ready = scheduleCalendarSync(queue, opts.env.tickMs);
  return {
    registered: true,
    ready,
    // Worker first: close() waits for an in-flight sweep, then the queue connection goes.
    close: async () => {
      await ready.catch(() => undefined);
      await worker.close();
      await queue.close();
    },
  };
}
