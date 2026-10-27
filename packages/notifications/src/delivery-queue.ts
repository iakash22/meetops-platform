import { UnrecoverableError, type Job, type JobsOptions, type Queue } from 'bullmq';
import { Value } from '@sinclair/typebox/value';
import { createQueue, createWorker } from '@meetops/queue';
import { logger as baseLogger } from '@meetops/logger';
import {
  NOTIFICATION_DELIVERY_JOB_RETENTION,
  NOTIFICATION_DELIVERY_QUEUE,
  NotificationDeliveryJobPayload as PayloadSchema,
  type NotificationDeliveryJobPayload,
} from '@meetops/contracts';

export const NOTIFICATION_DELIVERY_QUEUE_NAME = NOTIFICATION_DELIVERY_QUEUE;
export const NOTIFICATION_DELIVERY_JOB_NAME = 'deliver_notification';
export type { NotificationDeliveryJobPayload };

/** ADR-013: retries with exponential backoff (BullMQ adds jitter-free delays; providers add their own). */
export const DEFAULT_NOTIFICATION_JOB_OPTIONS = {
  attempts: 6,
  backoff: { type: 'exponential', delay: 5000 },
  removeOnComplete: { ...NOTIFICATION_DELIVERY_JOB_RETENTION.removeOnComplete },
  removeOnFail: { ...NOTIFICATION_DELIVERY_JOB_RETENTION.removeOnFail },
} satisfies JobsOptions;

export class InvalidNotificationJobError extends UnrecoverableError {}
/** Permanent failure (gone device, opted out, membership removed): no retry. */
export class PermanentNotificationError extends UnrecoverableError {}

/** Only the contract schema; a job without organizationId never reaches a handler. */
export function validateNotificationJobPayload(p: unknown): asserts p is NotificationDeliveryJobPayload {
  if (!Value.Check(PayloadSchema, p)) {
    const first = Value.Errors(PayloadSchema, p).First();
    throw new InvalidNotificationJobError(
      `Invalid notification job: schema violation${first ? ` at ${first.path || '/'}` : ''}`,
    );
  }
}

type QueueLike = Pick<Queue<NotificationDeliveryJobPayload>, 'add' | 'close'>;

export interface NotificationDeliveryProducer {
  /** jobId = deliveryKey, so a replayed fan-out never enqueues a second delivery. */
  enqueue(payload: NotificationDeliveryJobPayload, opts?: Omit<JobsOptions, 'jobId'>): Promise<string | undefined>;
  close(): Promise<void>;
}

export function createNotificationDeliveryProducer(
  queue: QueueLike = createQueue<NotificationDeliveryJobPayload>(NOTIFICATION_DELIVERY_QUEUE_NAME),
): NotificationDeliveryProducer {
  return {
    async enqueue(payload, opts) {
      validateNotificationJobPayload(payload);
      const job = await queue.add(NOTIFICATION_DELIVERY_JOB_NAME, payload, {
        ...DEFAULT_NOTIFICATION_JOB_OPTIONS,
        ...opts,
        jobId: payload.deliveryKey,
      });
      return job.id;
    },
    async close() {
      await queue.close();
    },
  };
}

export interface ChannelResult {
  status: 'sent' | 'skipped';
  providerMessageId?: string;
}

/**
 * Implemented by the worker app. `runInOrganization` MUST enter withOrganizationContext(organizationId) (forced RLS);
 * `deliver` re-checks membership and preferences inside it before calling the channel. `record` writes the
 * per-attempt row.
 */
export interface NotificationDeliveryHandler {
  runInOrganization<T>(organizationId: string, fn: () => Promise<T>): Promise<T>;
  deliver(payload: NotificationDeliveryJobPayload): Promise<ChannelResult>;
  record(
    payload: NotificationDeliveryJobPayload,
    attempt: number,
    outcome: { status: 'sent' | 'skipped' | 'failed'; providerMessageId?: string; errorCode?: string },
  ): Promise<void>;
}

export function createNotificationDeliveryProcessor(handler: NotificationDeliveryHandler) {
  return async (
    job: Pick<Job<NotificationDeliveryJobPayload>, 'id' | 'data' | 'attemptsMade'>,
  ): Promise<ChannelResult> => {
    validateNotificationJobPayload(job.data);
    const payload = job.data;
    const attempt = job.attemptsMade + 1;
    return handler.runInOrganization(payload.organizationId, async () => {
      try {
        const r = await handler.deliver(payload);
        await handler.record(payload, attempt, {
          status: r.status,
          ...(r.providerMessageId ? { providerMessageId: r.providerMessageId } : {}),
        });
        return r;
      } catch (err) {
        const errorCode = err instanceof Error ? err.name.slice(0, 64) : 'unknown';
        await handler.record(payload, attempt, { status: 'failed', errorCode });
        throw err;
      }
    });
  };
}

/** Worker stub: channel adapters (Web Push, Expo, email, in-app socket) plug in through the handler. */
export function startNotificationDeliveryWorker(
  handler: NotificationDeliveryHandler,
  options: { concurrency?: number } = {},
) {
  const log = baseLogger.child({ component: 'notification-delivery-worker' });
  const processor = createNotificationDeliveryProcessor(handler);
  const worker = createWorker<NotificationDeliveryJobPayload, ChannelResult>(
    NOTIFICATION_DELIVERY_QUEUE_NAME,
    (job) => processor(job),
    { concurrency: options.concurrency ?? 10 },
  );
  log.info({ queue: NOTIFICATION_DELIVERY_QUEUE_NAME }, 'notification delivery worker started');
  return worker;
}
