import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';
import { MeetingStatus } from '../domain/meeting.js';
import { TaskStatus } from '../domain/task.js';

/**
 * Server-to-client realtime events (Socket.IO). Payloads use contract ids and statuses
 * (`organizationId`, `meetingId`, `taskId`). Error text sent to clients must be generic.
 */
export const REALTIME_EVENTS = {
  meetingStatus: 'meeting:status',
  transcriptionProgress: 'transcription:progress',
  taskUpdate: 'task:update',
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
  Type.Object({ event: Type.Literal('meeting:status'), data: MeetingStatusEvent }, { additionalProperties: false }),
  Type.Object({ event: Type.Literal('transcription:progress'), data: TranscriptionProgressEvent }, { additionalProperties: false }),
  Type.Object({ event: Type.Literal('task:update'), data: TaskUpdateEvent }, { additionalProperties: false }),
]);
export type RealtimeEvent = Static<typeof RealtimeEvent>;

/** Event name to payload schema. */
export const RealtimeEventSchemas = {
  'meeting:status': MeetingStatusEvent,
  'transcription:progress': TranscriptionProgressEvent,
  'task:update': TaskUpdateEvent,
} as const;

/** Event name to payload type map, usable as Socket.IO ServerToClientEvents. */
export type RealtimeEventMap = {
  'meeting:status': MeetingStatusEvent;
  'transcription:progress': TranscriptionProgressEvent;
  'task:update': TaskUpdateEvent;
};
export type ServerToClientEvents = { [K in keyof RealtimeEventMap]: (payload: RealtimeEventMap[K]) => void };
