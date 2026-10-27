import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';
import { TranscriptProviderId } from '../jobs/index.js';

export const MeetingSource = Type.Union([
  Type.Literal('upload'),
  Type.Literal('extension'),
  Type.Literal('desktop'),
  Type.Literal('bot'),
]);
export type MeetingSource = Static<typeof MeetingSource>;

export const MeetingStatus = Type.Union([
  Type.Literal('scheduled'),
  Type.Literal('recording'),
  Type.Literal('processing'),
  Type.Literal('completed'),
  Type.Literal('failed'),
]);
export type MeetingStatus = Static<typeof MeetingStatus>;

export const Meeting = Type.Object({
  id: Id,
  organizationId: Id,
  projectId: Type.Optional(Id),
  title: Type.String({ minLength: 1, maxLength: 300 }),
  source: MeetingSource,
  status: MeetingStatus,
  startedAt: Type.Optional(IsoDateTime),
  endedAt: Type.Optional(IsoDateTime),
  /** Null for bot or import sources. */
  createdById: Type.Union([Id, Type.Null()]),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Meeting = Static<typeof Meeting>;

export const MeetingParticipantRole = Type.Union([
  Type.Literal('host'),
  Type.Literal('participant'),
]);
export type MeetingParticipantRole = Static<typeof MeetingParticipantRole>;

/** A person in a meeting; `userId` is null for external attendees. */
export const MeetingParticipant = Type.Object({
  id: Id,
  meetingId: Id,
  organizationId: Id,
  userId: Type.Union([Id, Type.Null()]),
  displayName: Type.String({ minLength: 1, maxLength: 200 }),
  email: Type.Optional(Type.Union([Type.String({ format: 'email', maxLength: 320 }), Type.Null()])),
  role: MeetingParticipantRole,
  joinedAt: Type.Optional(IsoDateTime),
  leftAt: Type.Optional(IsoDateTime),
});
export type MeetingParticipant = Static<typeof MeetingParticipant>;

export const TranscriptSegment = Type.Object({
  id: Id,
  index: Type.Integer({ minimum: 0 }),
  startMs: Type.Integer({ minimum: 0 }),
  endMs: Type.Integer({ minimum: 0 }),
  speaker: Type.Optional(Type.String()),
  text: Type.String(),
  confidence: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
});
export type TranscriptSegment = Static<typeof TranscriptSegment>;

export const Transcript = Type.Object({
  id: Id,
  meetingId: Id,
  recordingId: Id,
  language: Type.Optional(Type.String()),
  /** STT provider that produced the transcript. `'unknown'` only on legacy backfilled rows. */
  provider: TranscriptProviderId,
  /** Provider-side job id (e.g. AssemblyAI transcript id), for reconciliation. */
  providerJobId: Type.Optional(Type.String({ maxLength: 200 })),
  segments: Type.Array(TranscriptSegment),
  createdAt: IsoDateTime,
});
export type Transcript = Static<typeof Transcript>;

export const ReportActionItem = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 500 }),
    /** UNTRUSTED LLM output; display only. */
    assigneeHint: Type.Optional(Type.String({ maxLength: 200 })),
    dueHint: Type.Optional(Type.String({ maxLength: 100 })),
  },
  { additionalProperties: false },
);
export type ReportActionItem = Static<typeof ReportActionItem>;

/** Shape of the DB `reports.content` JSON column. Validate on write and on read. */
export const ReportContent = Type.Object(
  {
    summary: Type.String({ maxLength: 20000 }),
    decisions: Type.Array(Type.String({ maxLength: 2000 })),
    risks: Type.Array(Type.String({ maxLength: 2000 })),
    actionItems: Type.Array(ReportActionItem),
  },
  { additionalProperties: false },
);
export type ReportContent = Static<typeof ReportContent>;

/** Report DTO: ReportContent fields at top level, plus the AI run that produced it (null if manual or imported). */
export const Report = Type.Object({
  id: Id,
  organizationId: Id,
  meetingId: Id,
  ...ReportContent.properties,
  aiRunId: Type.Union([Id, Type.Null()]),
  createdAt: IsoDateTime,
});
export type Report = Static<typeof Report>;
