import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { Id, type NotificationDeliveryJobPayload } from '@meetops/contracts';

/**
 * ADR-013 outbox relay -> notification fan-out. Storage, queue and clock are ports so the logic is unit-testable;
 * the worker app provides Prisma adapters that enter withOrganizationContext(organizationId) for every call
 * (forced RLS) and claim events only through the SECURITY DEFINER relay functions (no table access, no BYPASSRLS).
 */

export type FanoutChannel = NotificationDeliveryJobPayload['channel'];
export type MembershipRoleName = 'owner' | 'admin' | 'member' | 'viewer';

export interface ClaimedOutboxEvent {
  id: string;
  organizationId: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: unknown;
  /** Attempts INCLUDING this claim (the claim function increments). */
  attempts: number;
}

export interface OutboxSource {
  /** Claims ONLY pending events whose type is in `eventTypes`; other types stay pending for their own consumers. */
  claim(limit: number, eventTypes: readonly string[]): Promise<ClaimedOutboxEvent[]>;
  complete(
    id: string,
    outcome: { published: true } | { published: false; error: string; retryAt?: Date },
  ): Promise<void>;
}

export interface FanoutPreference {
  type: string;
  channel: FanoutChannel;
  enabled: boolean;
}

/** All methods run inside the event's organization context. */
export interface FanoutStore {
  recipients(organizationId: string, roles: readonly MembershipRoleName[]): Promise<string[]>;
  preferences(organizationId: string, userId: string): Promise<FanoutPreference[]>;
  createNotification(
    organizationId: string,
    input: {
      userId: string;
      type: string;
      dedupeKey: string;
      subjectType: string;
      subjectId: string;
      data: Record<string, string | number | boolean | null>;
    },
  ): Promise<{ id: string }>;
}

export interface DeliveryEnqueuer {
  enqueue(p: NotificationDeliveryJobPayload): Promise<unknown>;
}

const ExtractedTasksPayload = Type.Object({
  kind: Type.Optional(Type.String({ maxLength: 64 })),
  meetingId: Id,
  reportId: Id,
  aiRunId: Type.Optional(Id),
  count: Type.Integer({ minimum: 1, maximum: 1000 }),
});
const SummaryReadyPayload = Type.Object({
  meetingId: Id,
  reportId: Id,
  transcriptRevision: Type.Optional(Type.Integer({ minimum: 1 })),
});

type Rule<P> = {
  kind: string;
  roles: readonly MembershipRoleName[];
  channels: readonly FanoutChannel[];
  parse(payload: unknown): P | undefined;
  subject(p: P): { subjectType: string; subjectId: string };
  data(p: P): Record<string, string | number | boolean | null>;
};

const parser =
  <S extends Parameters<typeof Value.Check>[0]>(schema: S) =>
  (p: unknown) =>
    Value.Check(schema, p) ? p : undefined;

/**
 * Event type -> notification kind. Recipients are org members by role (server-derived, never from the payload).
 * `tasks.ready_for_review` goes to roles that may accept extracted tasks (CASL: owner/admin/member); viewers get
 * summaries only.
 */
export const OUTBOX_NOTIFICATION_RULES = {
  'extracted_tasks.pending_review': {
    kind: 'tasks.ready_for_review',
    roles: ['owner', 'admin', 'member'],
    channels: ['in_app', 'web_push', 'mobile_push'],
    parse: parser(ExtractedTasksPayload),
    subject: (p: Static<typeof ExtractedTasksPayload>) => ({
      subjectType: 'meeting',
      subjectId: p.meetingId,
    }),
    data: (p: Static<typeof ExtractedTasksPayload>) => ({
      meetingId: p.meetingId,
      reportId: p.reportId,
      count: p.count,
    }),
  } satisfies Rule<Static<typeof ExtractedTasksPayload>>,
  'meeting.summary_ready': {
    kind: 'meeting.summary_ready',
    roles: ['owner', 'admin', 'member', 'viewer'],
    channels: ['in_app'],
    parse: parser(SummaryReadyPayload),
    subject: (p: Static<typeof SummaryReadyPayload>) => ({
      subjectType: 'meeting',
      subjectId: p.meetingId,
    }),
    data: (p: Static<typeof SummaryReadyPayload>) => ({
      meetingId: p.meetingId,
      reportId: p.reportId,
    }),
  } satisfies Rule<Static<typeof SummaryReadyPayload>>,
} as const;
export type OutboxNotificationEventType = keyof typeof OUTBOX_NOTIFICATION_RULES;

/** Channel defaults when the user has no matching preference. Email is opt-in for these kinds. */
export const DEFAULT_CHANNEL_ENABLED: Readonly<Record<FanoutChannel, boolean>> = {
  in_app: true,
  web_push: true,
  mobile_push: true,
  email: false,
  desktop: false,
};

/** Most specific wins: (kind, channel) > ('*', channel) > default. */
export function channelEnabled(
  prefs: readonly FanoutPreference[],
  kind: string,
  channel: FanoutChannel,
): boolean {
  const exact = prefs.find((p) => p.type === kind && p.channel === channel);
  if (exact) return exact.enabled;
  const wild = prefs.find((p) => p.type === '*' && p.channel === channel);
  if (wild) return wild.enabled;
  return DEFAULT_CHANNEL_ENABLED[channel];
}

export class OutboxPayloadError extends Error {
  constructor() {
    super('outbox payload does not match its event schema');
    this.name = 'OutboxPayloadError';
  }
}

export type FanoutResult =
  { ignored: true } | { ignored: false; notifications: number; jobs: number };

/** Fan one claimed event out to notification rows + delivery jobs. Idempotent (dedupeKey + jobId = deliveryKey). */
export async function fanoutEvent(
  e: ClaimedOutboxEvent,
  deps: { store: FanoutStore; producer: DeliveryEnqueuer },
): Promise<FanoutResult> {
  const rule = (OUTBOX_NOTIFICATION_RULES as Record<string, Rule<unknown>>)[e.eventType];
  if (!rule) return { ignored: true };
  const payload = rule.parse(e.payload);
  if (payload === undefined) throw new OutboxPayloadError();
  const org = e.organizationId;
  const users = [...new Set(await deps.store.recipients(org, rule.roles))];
  let notifications = 0;
  let jobs = 0;
  for (const userId of users) {
    const prefs = await deps.store.preferences(org, userId);
    const channels = rule.channels.filter((c) => channelEnabled(prefs, rule.kind, c));
    if (channels.length === 0) continue;
    const n = await deps.store.createNotification(org, {
      userId,
      type: rule.kind,
      dedupeKey: `outbox:${e.id}`,
      ...rule.subject(payload),
      data: rule.data(payload),
    });
    notifications++;
    for (const channel of channels) {
      await deps.producer.enqueue({
        jobVersion: 1,
        kind: 'deliver_notification',
        organizationId: org,
        userId,
        notificationId: n.id,
        channel,
        deliveryKey: `${n.id}:${channel}`,
      });
      jobs++;
    }
  }
  return { ignored: false, notifications, jobs };
}

export const MAX_RELAY_ATTEMPTS = 5;
/** 30s, 60s, 120s ... capped at 1h. */
/** Event types this relay claims (one per rule). */
export const RELAY_EVENT_TYPES: readonly string[] = Object.freeze(
  Object.keys(OUTBOX_NOTIFICATION_RULES),
);

export const relayBackoffMs = (attempts: number) =>
  Math.min(30_000 * 2 ** Math.max(0, attempts - 1), 3_600_000);

type Log = { info(o: object, m: string): void; warn(o: object, m: string): void };

/**
 * One relay pass: claim due events, fan out, report the outcome. Bad payloads fail permanently; other errors retry
 * with backoff up to MAX_RELAY_ATTEMPTS. Only event types with a rule are claimed (kind filter in the claim query), so
 * other consumers' events (e.g. auth.new_location_signin) are never touched. A rule-less event that is somehow
 * claimed is put back to pending, never marked published. Logs carry ids/codes only.
 */
export async function relayOutboxOnce(deps: {
  source: OutboxSource;
  store: FanoutStore;
  producer: DeliveryEnqueuer;
  logger: Log;
  limit?: number;
  now?: () => number;
}): Promise<{
  claimed: number;
  published: number;
  retried: number;
  failed: number;
  skipped: number;
}> {
  const now = deps.now ?? Date.now;
  const events = await deps.source.claim(deps.limit ?? 100, RELAY_EVENT_TYPES);
  const out = { claimed: events.length, published: 0, retried: 0, failed: 0, skipped: 0 };
  for (const e of events) {
    const log = {
      outboxEventId: e.id,
      organizationId: e.organizationId,
      eventType: e.eventType,
      attempts: e.attempts,
    };
    if (!Object.hasOwn(OUTBOX_NOTIFICATION_RULES, e.eventType)) {
      await deps.source.complete(e.id, {
        published: false,
        error: 'unhandled_event_type',
        retryAt: new Date(now()),
      });
      out.skipped++;
      deps.logger.warn(log, 'outbox event type not handled by this relay; released unpublished');
      continue;
    }
    try {
      const r = await fanoutEvent(e, deps);
      await deps.source.complete(e.id, { published: true });
      out.published++;
      deps.logger.info({ ...log, ...r }, 'outbox event relayed');
    } catch (err) {
      const code = err instanceof Error ? err.name.slice(0, 64) : 'unknown';
      const permanent = err instanceof OutboxPayloadError || e.attempts >= MAX_RELAY_ATTEMPTS;
      await deps.source.complete(
        e.id,
        permanent
          ? { published: false, error: code }
          : {
              published: false,
              error: code,
              retryAt: new Date(now() + relayBackoffMs(e.attempts)),
            },
      );
      if (permanent) out.failed++;
      else out.retried++;
      deps.logger.warn({ ...log, errorCode: code, permanent }, 'outbox event relay failed');
    }
  }
  return out;
}
