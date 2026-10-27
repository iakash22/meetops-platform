import type { NotificationDeliveryJobPayload, NotificationNewEvent } from '@meetops/contracts';
import {
  PermanentNotificationError,
  type ChannelResult,
  type NotificationDeliveryHandler,
} from './delivery-queue.js';
import { channelEnabled, type FanoutPreference } from './fanout.js';
import {
  EXPO_PUSH_URL,
  PushTargetRejectedError,
  assertDeliverableWebPushEndpoint,
  assertExpoPushToken,
  buildPushPayload,
  type PushPayload,
} from './push.js';
import type { DnsLookup } from '@meetops/ai-core';

/** Retryable delivery failure (rate limit, 5xx, timeout). BullMQ retries with the job's bounded backoff. */
export class TransientNotificationError extends Error {
  constructor(readonly code: string) {
    super(`notification delivery failed: ${code}`);
    this.name = 'TransientNotificationError';
  }
}

export type PushSendResult =
  | { status: 'sent'; providerMessageId?: string }
  /** Device token/subscription is permanently invalid (Expo DeviceNotRegistered, Web Push 404/410). */
  | { status: 'gone' }
  | { status: 'transient'; code: string }
  | { status: 'rejected'; code: string };

export interface PushSender {
  readonly channel: 'web_push' | 'mobile_push';
  send(token: string, payload: PushPayload): Promise<PushSendResult>;
}

export interface DeliveryDevice {
  id: string;
  platform: 'web' | 'extension' | 'ios' | 'android';
  /** Decrypted Web Push subscription JSON or Expo token. Never logged. */
  token: string;
}

/** Org-scoped store: every method enters withOrganizationContext(organizationId) itself. */
export interface DeliveryStore {
  isActiveMember(organizationId: string, userId: string): Promise<boolean>;
  preferences(organizationId: string, userId: string): Promise<FanoutPreference[]>;
  findNotification(
    organizationId: string,
    userId: string,
    notificationId: string,
  ): Promise<{ id: string; type: string; createdAt: Date } | undefined>;
  activeDevices(organizationId: string, userId: string): Promise<DeliveryDevice[]>;
  deleteDevice(organizationId: string, userId: string, deviceId: string): Promise<void>;
  recordAttempt(
    organizationId: string,
    input: {
      notificationId: string;
      channel: NotificationDeliveryJobPayload['channel'];
      deliveryKey: string;
      attempt: number;
      status: 'sent' | 'skipped' | 'failed';
      providerMessageId?: string | null;
      errorCode?: string | null;
    },
  ): Promise<void>;
}

export interface InAppPublisher {
  /** Emits `notification:new` to organizations:{org}:users:{user} only. */
  notificationNew(userId: string, e: NotificationNewEvent): void | Promise<void>;
}

const PLATFORMS: Record<'web_push' | 'mobile_push', ReadonlySet<DeliveryDevice['platform']>> = {
  web_push: new Set(['web', 'extension']),
  mobile_push: new Set(['ios', 'android']),
};

/**
 * Delivery handler for `deliver_notification` jobs. Re-checks membership, the notification row (owner) and the
 * user's preference at send time. Each channel has exactly one sender: there is no cross-channel or cross-provider
 * fallback (in particular never to a paid provider). Unconfigured channels are `skipped`.
 */
export function createNotificationDeliveryHandler(deps: {
  store: DeliveryStore;
  inApp?: InAppPublisher | undefined;
  webPush?: PushSender | undefined;
  mobilePush?: PushSender | undefined;
  now?: () => Date;
}): NotificationDeliveryHandler {
  const now = deps.now ?? (() => new Date());
  const skipped = (): ChannelResult => ({ status: 'skipped' });
  return {
    // The store enters withOrganizationContext per call; this only fixes the org for the job.
    runInOrganization: (_organizationId, fn) => fn(),
    async deliver(p) {
      const { organizationId: org, userId } = p;
      if (!(await deps.store.isActiveMember(org, userId)))
        throw new PermanentNotificationError('not_a_member');
      const n = await deps.store.findNotification(org, userId, p.notificationId);
      if (!n) throw new PermanentNotificationError('notification_not_found');
      const prefs = await deps.store.preferences(org, userId);
      if (!channelEnabled(prefs, n.type, p.channel)) return skipped();

      if (p.channel === 'in_app') {
        if (!deps.inApp) return skipped();
        await deps.inApp.notificationNew(userId, {
          organizationId: org,
          notificationId: n.id,
          kind: n.type.slice(0, 64),
          at: now().toISOString(),
        });
        return { status: 'sent' };
      }
      const channel = p.channel;
      if (channel !== 'web_push' && channel !== 'mobile_push') return skipped();
      const sender = channel === 'web_push' ? deps.webPush : deps.mobilePush;
      if (!sender) return skipped();
      const devices = (await deps.store.activeDevices(org, userId)).filter((d) =>
        PLATFORMS[channel].has(d.platform),
      );
      if (devices.length === 0) return skipped();
      const payload = buildPushPayload(n.id);
      let sentId: string | undefined;
      let sent = false;
      let transient: string | undefined;
      for (const d of devices) {
        const r = await sender.send(d.token, payload);
        if (r.status === 'sent') {
          sent = true;
          sentId ??= r.providerMessageId;
        } else if (r.status === 'gone' || r.status === 'rejected') {
          // Invalid or no-longer-allowlisted target: remove it so it is never retried.
          await deps.store.deleteDevice(org, userId, d.id);
        } else transient ??= r.code;
      }
      if (sent) return { status: 'sent', ...(sentId ? { providerMessageId: sentId } : {}) };
      if (transient) throw new TransientNotificationError(transient);
      return skipped();
    },
    async record(p, attempt, outcome) {
      await deps.store.recordAttempt(p.organizationId, {
        notificationId: p.notificationId,
        channel: p.channel,
        deliveryKey: p.deliveryKey,
        attempt,
        status: outcome.status,
        providerMessageId: outcome.providerMessageId ?? null,
        errorCode: outcome.errorCode ?? null,
      });
    },
  };
}

type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Expo Push sender: fixed EXPO_PUSH_URL only (token never builds a URL), redirects refused, per-request timeout,
 * generic payload. Expo is free; there is no fallback provider.
 */
export function createExpoPushSender(
  opts: { fetch?: FetchLike; accessToken?: string | undefined; timeoutMs?: number } = {},
): PushSender {
  const f = opts.fetch ?? ((u, i) => fetch(u, i));
  return {
    channel: 'mobile_push',
    async send(token, payload) {
      try {
        assertExpoPushToken(token);
      } catch {
        return { status: 'rejected', code: 'invalid_token' };
      }
      let res: Response;
      try {
        res = await f(EXPO_PUSH_URL, {
          method: 'POST',
          redirect: 'manual',
          signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000),
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            ...(opts.accessToken ? { authorization: `Bearer ${opts.accessToken}` } : {}),
          },
          body: JSON.stringify([
            { to: token, title: payload.title, body: payload.body, data: payload.data },
          ]),
        });
      } catch {
        return { status: 'transient', code: 'expo_network' };
      }
      if (res.status >= 300 && res.status < 400)
        return { status: 'transient', code: 'expo_redirect_refused' };
      if (res.status === 429 || res.status >= 500)
        return { status: 'transient', code: `expo_${res.status}` };
      if (!res.ok) return { status: 'transient', code: `expo_${res.status}` };
      const body = (await res.json().catch(() => undefined)) as
        | { data?: Array<{ status?: string; id?: string; details?: { error?: string } }> }
        | undefined;
      const t = body?.data?.[0];
      if (t?.status === 'ok')
        return {
          status: 'sent',
          ...(t.id ? { providerMessageId: String(t.id).slice(0, 200) } : {}),
        };
      if (t?.details?.error === 'DeviceNotRegistered') return { status: 'gone' };
      if (t?.details?.error === 'MessageRateExceeded')
        return { status: 'transient', code: 'expo_rate_limited' };
      return { status: 'transient', code: 'expo_bad_ticket' };
    },
  };
}

/** Encrypts + signs (VAPID, RFC 8291 aes128gcm) and POSTs to an already-vetted endpoint. Provided by the host. */
export interface WebPushTransport {
  send(
    target: { endpoint: string; keys: { p256dh: string; auth: string }; pinnedAddress: string },
    payloadJson: string,
  ): Promise<{ statusCode: number; messageId?: string }>;
}

/**
 * Web Push sender: re-validates the subscription at send time (allowlisted host, ADR-009 SSRF guard with DNS and
 * private-address rejection, pinned address) before the transport is called. The transport must not follow
 * redirects. 404/410 = gone; 429/5xx = transient.
 */
export function createWebPushSender(opts: {
  transport: WebPushTransport;
  lookup?: DnsLookup;
}): PushSender {
  return {
    channel: 'web_push',
    async send(token, payload) {
      let sub: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
      try {
        sub = JSON.parse(token) as typeof sub;
      } catch {
        return { status: 'rejected', code: 'invalid_subscription' };
      }
      if (
        typeof sub.endpoint !== 'string' ||
        typeof sub.keys?.p256dh !== 'string' ||
        typeof sub.keys.auth !== 'string'
      )
        return { status: 'rejected', code: 'invalid_subscription' };
      let pinned: string;
      try {
        const safe = await assertDeliverableWebPushEndpoint(sub.endpoint, opts.lookup);
        if (!safe.pinned) return { status: 'rejected', code: 'endpoint_not_pinned' };
        pinned = safe.pinned.address;
      } catch (e) {
        return {
          status: 'rejected',
          code: e instanceof PushTargetRejectedError ? 'endpoint_rejected' : 'endpoint_error',
        };
      }
      try {
        const r = await opts.transport.send(
          {
            endpoint: sub.endpoint,
            keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
            pinnedAddress: pinned,
          },
          JSON.stringify(payload),
        );
        if (r.statusCode >= 200 && r.statusCode < 300)
          return {
            status: 'sent',
            ...(r.messageId ? { providerMessageId: r.messageId.slice(0, 200) } : {}),
          };
        if (r.statusCode === 404 || r.statusCode === 410) return { status: 'gone' };
        if (r.statusCode === 429 || r.statusCode >= 500)
          return { status: 'transient', code: `webpush_${r.statusCode}` };
        return { status: 'transient', code: `webpush_${r.statusCode}` };
      } catch {
        return { status: 'transient', code: 'webpush_network' };
      }
    },
  };
}
