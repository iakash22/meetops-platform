import {
  createNotificationRepository,
  getPrismaClient,
  withOrganizationContext,
  type DatabaseClient,
  type NotificationRepository,
  type PushTokenCipher,
} from '@meetops/database';
import {
  createExpoPushSender,
  createNotificationDeliveryHandler,
  relayOutboxOnce,
  startNotificationDeliveryWorker,
  type ClaimedOutboxEvent,
  type DeliveryEnqueuer,
  type DeliveryStore,
  type FanoutStore,
  type InAppPublisher,
  type OutboxSource,
  type PushSender,
} from '@meetops/notifications';
import { logger as baseLogger } from '../logger.js';

type Log = {
  info(o: object, m: string): void;
  warn(o: object, m: string): void;
  error(o: object, m: string): void;
};

/**
 * Outbox claims go ONLY through the SECURITY DEFINER relay functions (migration 20261022033000): the relay
 * connection (meetops_relay, NOBYPASSRLS) has no table privileges, so it can only claim due events and report
 * outcomes. Fan-out writes then run as the app role inside withOrganizationContext(event.org_id).
 */
export function createPrismaOutboxSource(relay: DatabaseClient): OutboxSource {
  return {
    async claim(limit) {
      const rows = await relay.$queryRaw<
        Array<{
          id: string;
          org_id: string;
          aggregate_type: string;
          aggregate_id: string;
          event_type: string;
          payload: unknown;
          attempts: number;
        }>
      >`SELECT * FROM public.relay_claim_outbox_events(${Math.min(Math.max(1, limit), 500)}::int)`;
      return rows.map((r): ClaimedOutboxEvent => ({
        id: r.id,
        organizationId: r.org_id,
        aggregateType: r.aggregate_type,
        aggregateId: r.aggregate_id,
        eventType: r.event_type,
        payload: r.payload,
        attempts: Number(r.attempts),
      }));
    },
    async complete(id, o) {
      const published = o.published;
      const error = o.published ? null : o.error.slice(0, 200);
      const retryAt = !o.published && o.retryAt ? o.retryAt : null;
      await relay.$queryRaw`SELECT public.relay_complete_outbox_event(${id}::uuid, ${published}, ${error}, ${retryAt}::timestamptz)`;
    },
  };
}

const roleList = ['owner', 'admin', 'member', 'viewer'] as const;

/** Fan-out store: every call enters the event's organization context (forced RLS). */
export function createPrismaFanoutStore(
  repo: NotificationRepository,
  client?: DatabaseClient,
): FanoutStore {
  const opts = client ? { client } : {};
  return {
    recipients: (organizationId, roles) =>
      withOrganizationContext(
        organizationId,
        async (tx) =>
          (
            await tx.membership.findMany({
              where: {
                organizationId,
                deletedAt: null,
                role: { in: roles.filter((r) => roleList.includes(r)) },
              },
              select: { userId: true },
              take: 5000,
            })
          ).map((m) => m.userId),
        opts,
      ),
    preferences: (organizationId, userId) => repo.getPreferences(organizationId, userId),
    createNotification: async (organizationId, input) => {
      const r = await repo.create(organizationId, input);
      return { id: r.id };
    },
  };
}

export function createPrismaDeliveryStore(
  repo: NotificationRepository,
  opts: { client?: DatabaseClient; pushEnabled: boolean },
): DeliveryStore {
  const db = opts.client ? { client: opts.client } : {};
  return {
    isActiveMember: (organizationId, userId) =>
      withOrganizationContext(
        organizationId,
        async (tx) =>
          (await tx.membership.count({ where: { organizationId, userId, deletedAt: null } })) > 0,
        db,
      ),
    preferences: (organizationId, userId) => repo.getPreferences(organizationId, userId),
    findNotification: async (organizationId, userId, id) => {
      const n = await repo.findForUser(organizationId, userId, id);
      return n ? { id: n.id, type: n.type, createdAt: n.createdAt } : undefined;
    },
    // Without a configured token cipher there is nothing to decrypt: push channels resolve to "skipped".
    activeDevices: async (organizationId, userId) =>
      opts.pushEnabled ? await repo.listActiveDevices(organizationId, userId) : [],
    deleteDevice: async (organizationId, userId, deviceId) => {
      await repo.unregisterDevice(organizationId, userId, deviceId);
    },
    recordAttempt: (organizationId, input) => repo.recordAttempt(organizationId, input),
  };
}

type EmitterLike = {
  to(room: string | string[]): { emit(event: string, payload: unknown): unknown };
};

/** Must match apps/realtime userRoom: organizations:{organizationId}:users:{userId}. */
export const userRoom = (organizationId: string, userId: string) =>
  `organizations:${organizationId}:users:${userId}`;

export function createInAppPublisher(emitter: EmitterLike): InAppPublisher {
  return {
    notificationNew: (userId, e) => {
      emitter.to(userRoom(e.organizationId, userId)).emit('notification:new', e);
    },
  };
}

export type NotificationsWorkerEnv = {
  enabled: boolean;
  relayIntervalMs: number;
  relayBatch: number;
  concurrency: number;
};

const truthy = (v: string | undefined) =>
  ['true', '1', 'yes', 'on'].includes((v ?? '').toLowerCase());
const int = (v: string | undefined, def: number, min: number, max: number) =>
  v && /^[0-9]{1,7}$/.test(v) ? Math.min(max, Math.max(min, Number(v))) : def;

/** NOTIFICATIONS_WORKER_ENABLED (default false), NOTIFICATIONS_RELAY_INTERVAL_MS, _RELAY_BATCH, _CONCURRENCY. */
export function loadNotificationsWorkerEnv(
  env: NodeJS.ProcessEnv = process.env,
): NotificationsWorkerEnv {
  return {
    enabled: truthy(env.NOTIFICATIONS_WORKER_ENABLED),
    relayIntervalMs: int(env.NOTIFICATIONS_RELAY_INTERVAL_MS, 5000, 500, 600_000),
    relayBatch: int(env.NOTIFICATIONS_RELAY_BATCH, 100, 1, 500),
    concurrency: int(env.NOTIFICATIONS_DELIVERY_CONCURRENCY, 5, 1, 50),
  };
}

/** Non-overlapping relay loop. Returns a stop function that waits for the in-flight pass. */
export function startOutboxRelay(deps: {
  source: OutboxSource;
  store: FanoutStore;
  producer: DeliveryEnqueuer;
  logger: Log;
  intervalMs: number;
  batch: number;
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void } | unknown;
  clearTimer?: (t: unknown) => void;
}) {
  const setT = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  const clearT = deps.clearTimer ?? ((t: unknown) => clearTimeout(t as NodeJS.Timeout));
  let stopped = false;
  let timer: unknown;
  let inflight: Promise<unknown> = Promise.resolve();
  const tick = () => {
    if (stopped) return;
    inflight = relayOutboxOnce({ ...deps, limit: deps.batch })
      .then((r) => {
        // Drain quickly while the batch is full.
        return r.claimed >= deps.batch ? 0 : deps.intervalMs;
      })
      .catch((err: unknown) => {
        deps.logger.error(
          { errorCode: err instanceof Error ? err.name : 'unknown' },
          'outbox relay pass failed',
        );
        return deps.intervalMs;
      })
      .then((wait) => {
        if (!stopped) timer = setT(tick, wait);
      });
  };
  tick();
  return {
    stop: async () => {
      stopped = true;
      clearT(timer);
      await inflight;
    },
  };
}

export type NotificationsWorkerDeps = {
  env?: NotificationsWorkerEnv;
  relayClient?: DatabaseClient | undefined;
  cipher?: PushTokenCipher | undefined;
  emitter?: EmitterLike | undefined;
  producer: DeliveryEnqueuer & { close?: () => Promise<void> };
  expoAccessToken?: string | undefined;
  /** No Web Push transport ships yet (VAPID + RFC 8291 encryption): leave undefined and web_push is skipped. */
  webPush?: PushSender | undefined;
  logger?: Log;
};

/**
 * Registers the outbox relay and the `deliver_notification` consumer when NOTIFICATIONS_WORKER_ENABLED=true and a
 * relay DB connection (DATABASE_RELAY_URL as meetops_relay) is injected. Expo is the only mobile sender (free); there
 * is no fallback provider for any channel.
 */
export function registerNotificationsWorker(
  deps: NotificationsWorkerDeps,
  start: { delivery?: typeof startNotificationDeliveryWorker } = {},
):
  | { registered: true; close: () => Promise<void> }
  | { registered: false; reason: 'disabled' | 'missing_dependencies' } {
  const env = deps.env ?? loadNotificationsWorkerEnv();
  const log = deps.logger ?? baseLogger.child({ component: 'notifications-worker' });
  if (!env.enabled) {
    log.info({}, 'notifications worker disabled (NOTIFICATIONS_WORKER_ENABLED=false)');
    return { registered: false, reason: 'disabled' };
  }
  if (!deps.relayClient) {
    log.warn({}, 'notifications worker enabled but no relay DB connection; not registered');
    return { registered: false, reason: 'missing_dependencies' };
  }
  const pushEnabled = !!deps.cipher;
  const repo = createNotificationRepository({
    client: getPrismaClient(),
    cipher: deps.cipher ?? {
      encrypt: () => Promise.reject(new Error('push token cipher not configured')),
      decrypt: () => Promise.reject(new Error('push token cipher not configured')),
    },
  });
  if (!pushEnabled)
    log.warn(
      {},
      'no push token cipher configured: web_push and mobile_push deliveries are skipped',
    );
  const relay = startOutboxRelay({
    source: createPrismaOutboxSource(deps.relayClient),
    store: createPrismaFanoutStore(repo),
    producer: deps.producer,
    logger: log,
    intervalMs: env.relayIntervalMs,
    batch: env.relayBatch,
  });
  const handler = createNotificationDeliveryHandler({
    store: createPrismaDeliveryStore(repo, { pushEnabled }),
    inApp: deps.emitter ? createInAppPublisher(deps.emitter) : undefined,
    mobilePush: pushEnabled
      ? createExpoPushSender({ accessToken: deps.expoAccessToken })
      : undefined,
    webPush: pushEnabled ? deps.webPush : undefined,
  });
  const worker = (start.delivery ?? startNotificationDeliveryWorker)(handler, {
    concurrency: env.concurrency,
  });
  return {
    registered: true,
    close: async () => {
      await relay.stop();
      await worker.close();
      await deps.producer.close?.();
    },
  };
}
