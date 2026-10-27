import { Type, type Static } from '@sinclair/typebox';
import { Id } from '../common.js';
import { MediaSourceExt } from './index.js';

/**
 * Media pipeline jobs on MEDIA_QUEUE (ADR-014). The BullMQ job name equals `kind`:
 * - `process_upload`: scan a direct upload (magic bytes, ffprobe, caps) and set its scanStatus.
 * - `assemble_recording_session`: concatenate a completed session's verified chunks into the recording source
 *   object, then enqueue `process_recording` (contracts `MediaJobPayload`).
 * - `process_recording`: normalize, chunk and transcribe (unchanged `MediaJobPayload`).
 */
export const MEDIA_JOB_NAMES = {
  processRecording: 'process_recording',
  processUpload: 'process_upload',
  assembleRecordingSession: 'assemble_recording_session',
} as const;
export type MediaJobName = (typeof MEDIA_JOB_NAMES)[keyof typeof MEDIA_JOB_NAMES];

export const UploadScanJobPayload = Type.Object(
  {
    jobVersion: Type.Literal(1),
    kind: Type.Literal('process_upload'),
    organizationId: Id,
    /** FileObject id of the upload. */
    uploadId: Id,
    consentAttestationId: Id,
    meetingId: Type.Optional(Id),
  },
  { additionalProperties: false },
);
export type UploadScanJobPayload = Static<typeof UploadScanJobPayload>;

export const AssembleRecordingSessionJobPayload = Type.Object(
  {
    jobVersion: Type.Literal(1),
    kind: Type.Literal('assemble_recording_session'),
    organizationId: Id,
    meetingId: Id,
    sessionId: Id,
    consentAttestationId: Id,
    /** Container of the session's chunks, from the session MIME type. */
    sourceExt: MediaSourceExt,
  },
  { additionalProperties: false },
);
export type AssembleRecordingSessionJobPayload = Static<typeof AssembleRecordingSessionJobPayload>;

/** ADR-013 outbox event type written when media processing fails terminally. */
export const MEETING_PROCESSING_FAILED_EVENT = 'meeting.processing_failed' as const;
/** Payload of the `meeting.processing_failed` outbox row: ids and a stable code only (no keys, URLs or paths). */
export const MeetingProcessingFailedPayload = Type.Object(
  {
    organizationId: Id,
    meetingId: Id,
    subjectType: Type.Union([Type.Literal('recording'), Type.Literal('recording_session')]),
    subjectId: Id,
    errorCode: Type.String({ minLength: 1, maxLength: 64, pattern: '^[a-z0-9_]+$' }),
    failedAt: Type.String({ format: 'date-time' }),
  },
  { additionalProperties: false },
);
export type MeetingProcessingFailedPayload = Static<typeof MeetingProcessingFailedPayload>;
