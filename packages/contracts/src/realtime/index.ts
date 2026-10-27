import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';
import { MeetingStatus } from '../domain/meeting.js';
import { TaskStatus } from '../domain/task.js';
import { Role } from '../domain/org.js';
import {
  AUTH_REVOCATION_KINDS,
  AUTH_REVOCATION_MESSAGE_VERSION,
  AUTH_REVOCATION_REASONS,
  ORG_ACCESS_CHANGE_REASONS,
  REAUTH_REASONS,
} from '../constants.js';

export {
  AUTH_REVOCATIONS_CHANNEL,
  AUTH_REVOCATION_KINDS,
  AUTH_REVOCATION_MESSAGE_VERSION,
  AUTH_REVOCATION_REASONS,
  MAX_REALTIME_REAUTH_INTERVAL_MS,
  ORG_ACCESS_CHANGE_REASONS,
  REALTIME_CONTROL_EVENTS,
  REALTIME_REAUTH_INTERVAL_MS,
  REAUTH_REASONS,
} from '../constants.js';

/**
 * Server-to-client realtime events (Socket.IO). Payloads use contract ids and statuses
 * (`organizationId`, `meetingId`, `taskId`). Error text sent to clients must be generic.
 */
export const REALTIME_EVENTS = {
  meetingStatus: 'meeting:status',
  transcriptionProgress: 'transcription:progress',
  taskUpdate: 'task:update',
  /** v0.13.0: AI summary (and action-item drafts) stored for a meeting. */
  summaryReady: 'summary:ready',
  /** v0.13.0: a new in-app notification row for the receiving user (user room only). */
  notificationNew: 'notification:new',
} as const;
export type RealtimeEventName = (typeof REALTIME_EVENTS)[keyof typeof REALTIME_EVENTS];

export const MeetingStatusEvent = Type.Object(
  {
    organizationId: Id,
    meetingId: Id,
    status: MeetingStatus,
    at: IsoDateTime,
    /** Generic, user-safe failure reason; never raw provider errors. */
    errorCode: Type.Optional(Type.String({ maxLength: 64 })),
  },
  { additionalProperties: false },
);
export type MeetingStatusEvent = Static<typeof MeetingStatusEvent>;

export const TranscriptionStage = Type.Union([
  Type.Literal('normalizing'),
  Type.Literal('chunking'),
  Type.Literal('transcribing'),
  Type.Literal('merging'),
]);
export type TranscriptionStage = Static<typeof TranscriptionStage>;

export const TranscriptionProgressEvent = Type.Object(
  {
    organizationId: Id,
    meetingId: Id,
    recordingId: Type.Optional(Id),
    percent: Type.Number({ minimum: 0, maximum: 100 }),
    stage: Type.Optional(TranscriptionStage),
    chunksDone: Type.Optional(Type.Integer({ minimum: 0 })),
    chunksTotal: Type.Optional(Type.Integer({ minimum: 0 })),
    at: IsoDateTime,
  },
  { additionalProperties: false },
);
export type TranscriptionProgressEvent = Static<typeof TranscriptionProgressEvent>;

export const TaskUpdateEvent = Type.Object(
  {
    organizationId: Id,
    taskId: Id,
    meetingId: Type.Optional(Id),
    status: TaskStatus,
    title: Type.Optional(Type.String({ maxLength: 500 })),
    assigneeId: Type.Optional(Id),
    at: IsoDateTime,
  },
  { additionalProperties: false },
);
export type TaskUpdateEvent = Static<typeof TaskUpdateEvent>;

/** Discriminated union on `event`, e.g. for a Redis emitter or a single client handler. */
export const RealtimeEvent = Type.Union([
  Type.Object(
    { event: Type.Literal('meeting:status'), data: MeetingStatusEvent },
    { additionalProperties: false },
  ),
  Type.Object(
    { event: Type.Literal('transcription:progress'), data: TranscriptionProgressEvent },
    { additionalProperties: false },
  ),
  Type.Object(
    { event: Type.Literal('task:update'), data: TaskUpdateEvent },
    { additionalProperties: false },
  ),
]);
export type RealtimeEvent = Static<typeof RealtimeEvent>;

/**
 * v0.13.0: emitted by the summary worker to the meeting and organization rooms. Ids and counts only; clients fetch
 * the report / extracted tasks over HTTP.
 */
export const SummaryReadyEvent = Type.Object(
  {
    organizationId: Id,
    meetingId: Id,
    reportId: Id,
    transcriptRevision: Type.Integer({ minimum: 1 }),
    tasksPendingReview: Type.Integer({ minimum: 0, maximum: 1000 }),
    at: IsoDateTime,
  },
  { additionalProperties: false },
);
export type SummaryReadyEvent = Static<typeof SummaryReadyEvent>;

/**
 * v0.13.0: emitted to `organizations:{org}:users:{user}` only, when an in-app notification is created. No title or
 * body: the client refetches the feed (`NOTIFICATION_PATHS`).
 */
export const NotificationNewEvent = Type.Object(
  {
    organizationId: Id,
    notificationId: Id,
    kind: Type.String({ minLength: 1, maxLength: 64 }),
    at: IsoDateTime,
  },
  { additionalProperties: false },
);
export type NotificationNewEvent = Static<typeof NotificationNewEvent>;

/** Event name to payload schema. */
export const RealtimeEventSchemas = {
  'meeting:status': MeetingStatusEvent,
  'transcription:progress': TranscriptionProgressEvent,
  'task:update': TaskUpdateEvent,
  'summary:ready': SummaryReadyEvent,
  'notification:new': NotificationNewEvent,
} as const;

/** Event name to payload type map, usable as Socket.IO ServerToClientEvents. */
export type RealtimeEventMap = {
  'meeting:status': MeetingStatusEvent;
  'transcription:progress': TranscriptionProgressEvent;
  'task:update': TaskUpdateEvent;
  'summary:ready': SummaryReadyEvent;
  'notification:new': NotificationNewEvent;
};

// ---- v0.4.1: auth revocation and control events (ADR-011 sections 3 and 5) ----

const strict = { additionalProperties: false } as const;

/** Why access was revoked. See AUTH_REVOCATION_REASONS. */
export const AuthRevocationReason = Type.Union(AUTH_REVOCATION_REASONS.map((r) => Type.Literal(r)));
export type AuthRevocationReason = (typeof AUTH_REVOCATION_REASONS)[number];
/** AuthRevocationMessage `kind`. See AUTH_REVOCATION_KINDS. */
export const AuthRevocationKind = Type.Union(AUTH_REVOCATION_KINDS.map((k) => Type.Literal(k)));
export type AuthRevocationKind = (typeof AUTH_REVOCATION_KINDS)[number];

const revocationBase = {
  v: Type.Literal(AUTH_REVOCATION_MESSAGE_VERSION),
  userId: Id,
  reason: AuthRevocationReason,
  at: IsoDateTime,
};

/**
 * INTERNAL (api -> realtime). JSON message on the Redis channel AUTH_REVOCATIONS_CHANNEL (`meetops:auth:revocations`),
 * published after the change commits. Identifiers only: it never carries a token, cookie or token hash, and is strict so
 * one cannot be added. A message that fails this schema is dropped and counted by the subscriber.
 * - `session`: disconnect sockets of `sessionId` (sessions.id, or the extension token family id).
 * - `user`: disconnect every socket of `userId` (logout-all, password change).
 * - `membership`: disconnect every socket of `userId` in `organizationId` (member removed, role changed, invitation revoked).
 */
export const AuthRevocationMessage = Type.Union([
  Type.Object(
    {
      ...revocationBase,
      kind: Type.Literal('session'),
      sessionId: Id,
      organizationId: Type.Optional(Id),
    },
    strict,
  ),
  Type.Object({ ...revocationBase, kind: Type.Literal('user') }, strict),
  Type.Object({ ...revocationBase, kind: Type.Literal('membership'), organizationId: Id }, strict),
]);
export type AuthRevocationMessage = Static<typeof AuthRevocationMessage>;

/**
 * Server -> client `session:revoked`. Sent right before the server disconnects a socket whose session or token family
 * was revoked. Carries no ids or credentials. The client must not reconnect with the same credential.
 */
export const SessionRevokedEvent = Type.Object(
  { reason: AuthRevocationReason, at: IsoDateTime },
  strict,
);
export type SessionRevokedEvent = Static<typeof SessionRevokedEvent>;

/** `org:access-changed` reason. See ORG_ACCESS_CHANGE_REASONS. */
export const OrgAccessChangeReason = Type.Union(
  ORG_ACCESS_CHANGE_REASONS.map((r) => Type.Literal(r)),
);
export type OrgAccessChangeReason = (typeof ORG_ACCESS_CHANGE_REASONS)[number];

/**
 * Server -> client `org:access-changed`. Sent right before the server disconnects a socket whose membership in
 * `organizationId` (the socket's own organization) was removed or changed role. `role` is the new role and is present
 * only for `role_changed`. After `role_changed` the client may reconnect (the new socket gets the new role).
 */
export const OrgAccessChangedEvent = Type.Union([
  Type.Object(
    { organizationId: Id, reason: Type.Literal('member_removed'), at: IsoDateTime },
    strict,
  ),
  Type.Object(
    { organizationId: Id, reason: Type.Literal('role_changed'), role: Role, at: IsoDateTime },
    strict,
  ),
]);
export type OrgAccessChangedEvent = Static<typeof OrgAccessChangedEvent>;

/** `auth:reauth-required` reason. See REAUTH_REASONS. */
export const ReauthReason = Type.Union(REAUTH_REASONS.map((r) => Type.Literal(r)));
export type ReauthReason = (typeof REAUTH_REASONS)[number];

/**
 * Server -> client `auth:reauth-required` (G2). Sent right before the server disconnects a socket that must reconnect
 * with its current credential: `org_switch` (the session was rotated to another org), `session_expired` (the socket
 * outlived the session's `expiresAt`) or `revalidation_failed` (the periodic or on-join re-verification failed).
 */
export const AuthReauthRequiredEvent = Type.Object(
  { reason: ReauthReason, at: IsoDateTime },
  strict,
);
export type AuthReauthRequiredEvent = Static<typeof AuthReauthRequiredEvent>;

/** Discriminated union of the control events on `event`. */
export const RealtimeControlEvent = Type.Union([
  Type.Object({ event: Type.Literal('session:revoked'), data: SessionRevokedEvent }, strict),
  Type.Object({ event: Type.Literal('org:access-changed'), data: OrgAccessChangedEvent }, strict),
  Type.Object(
    { event: Type.Literal('auth:reauth-required'), data: AuthReauthRequiredEvent },
    strict,
  ),
]);
export type RealtimeControlEvent = Static<typeof RealtimeControlEvent>;

/** Control event name to payload schema. */
export const RealtimeControlEventSchemas = {
  'session:revoked': SessionRevokedEvent,
  'org:access-changed': OrgAccessChangedEvent,
  'auth:reauth-required': AuthReauthRequiredEvent,
} as const;

/** Control event name to payload type map. */
export type RealtimeControlEventMap = {
  'session:revoked': SessionRevokedEvent;
  'org:access-changed': OrgAccessChangedEvent;
  'auth:reauth-required': AuthReauthRequiredEvent;
};
export type RealtimeControlEventName = keyof RealtimeControlEventMap;

/**
 * Socket.IO ServerToClientEvents: the domain events (RealtimeEventMap) plus, from v0.4.1, the control events
 * (RealtimeControlEventMap).
 */
export type ServerToClientEvents = {
  [K in keyof RealtimeEventMap]: (payload: RealtimeEventMap[K]) => void;
} & { [K in keyof RealtimeControlEventMap]: (payload: RealtimeControlEventMap[K]) => void };
