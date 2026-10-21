import { Type, type Static } from '@sinclair/typebox';
import { Id, IsoDateTime } from '../common.js';

export const MeetingSource = Type.Union([
  Type.Literal('upload'),
  Type.Literal('extension'),
  Type.Literal('desktop'),
  Type.Literal('bot'),
]);
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
  createdById: Id,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Meeting = Static<typeof Meeting>;

export const TranscriptSegment = Type.Object({
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
  /** Router id of the STT provider used, e.g. "assemblyai" or "faster-whisper". */
  providerId: Type.String(),
  segments: Type.Array(TranscriptSegment),
  createdAt: IsoDateTime,
});
export type Transcript = Static<typeof Transcript>;

export const Report = Type.Object({
  id: Id,
  meetingId: Id,
  summary: Type.String(),
  decisions: Type.Array(Type.String()),
  risks: Type.Array(Type.String()),
  /** "<provider>:<model>" router id, e.g. "gemini:gemini-2.0-flash". */
  modelRouteId: Type.String(),
  createdAt: IsoDateTime,
});
export type Report = Static<typeof Report>;
