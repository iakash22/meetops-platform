/**
 * Realtime event contracts come from @meetops/contracts (PR #17). Only the
 * client->server events, socket data and room helpers are local.
 */
import type {
  MeetingStatus,
  MeetingStatusEvent,
  ServerToClientEvents,
  TaskUpdateEvent,
  TranscriptionProgressEvent,
  TranscriptionStage,
} from '@meetops/contracts';
import type { ControlServerToClientEvents } from './control-events.js';

export type {
  MeetingStatus,
  MeetingStatusEvent,
  ServerToClientEvents,
  TaskUpdateEvent,
  TranscriptionProgressEvent,
  TranscriptionStage,
};
export { REALTIME_EVENTS } from '@meetops/contracts';

/**
 * Reason codes. Contracts (ARC-2 0.4.1) defines no connect or join error codes, so they are local; candidates for
 * @meetops/contracts. Every handshake rejection uses the one generic connect error (ADR-011 section 1.5). On join,
 * 'invalid' = not a UUID, 'forbidden' = missing, deleted or other-org meeting (identical, ADR-011 section 4.2),
 * 'error' = the access check failed (fail closed).
 */
export const REALTIME_CONNECT_ERROR = 'unauthorized' as const;
export const MEETING_JOIN_ERRORS = ['invalid', 'forbidden', 'error'] as const;
export type MeetingJoinError = (typeof MEETING_JOIN_ERRORS)[number];

/** Meeting ids are UUIDs (ADR-011 section 4.2). */
export const MEETING_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type MeetingAccessInput = { organizationId: string; userId: string; meetingId: string };

export type AckResult = { ok: true } | { ok: false; error: MeetingJoinError };

export interface ClientToServerEvents {
  'meeting:join': (p: { meetingId: string }, ack: (r: AckResult) => void) => void;
  'meeting:leave': (p: { meetingId: string }, ack: (r: AckResult) => void) => void;
}

export type InterServerEvents = Record<string, never>;

export interface SocketData {
  userId: string;
  organizationId: string;
  /** Verified session id (cookie session or extension token id); kept for MR-2 revocation matching. */
  sessionId: string;
  /** 'session' = web cookie socket, 'extension' = bearer socket (never in the org room, ADR-011 section 1.3). */
  credential: 'session' | 'extension';
  /** Epoch ms after which the socket is told to re-authenticate and is disconnected. */
  expiresAt: number;
}

/** Organization room: organizations:{organizationId}. Every authenticated socket joins its own. */
export const organizationRoom = (organizationId: string) => `organizations:${organizationId}`;
/** Organization-scoped meeting room: organizations:{organizationId}:meetings:{meetingId}. */
export const meetingRoom = (organizationId: string, meetingId: string) =>
  `organizations:${organizationId}:meetings:${meetingId}`;

/**
 * Media upload/processing status events (owned by Media & Realtime). Local until upstreamed to @meetops/contracts;
 * apps/worker/src/media/types.ts mirrors these shapes. Payloads carry ids and codes only: never keys, URLs or paths.
 */
export const MEDIA_EVENTS = {
  uploadStatus: 'upload:status',
  processingStatus: 'processing:status',
} as const;

export const UPLOAD_STATUSES = ['pending', 'uploaded', 'verified', 'failed', 'expired'] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

export type UploadStatusEvent = {
  organizationId: string;
  meetingId: string;
  uploadId: string;
  status: UploadStatus;
  /** Present when status = verified (lowercase hex). */
  sha256?: string;
  sizeBytes?: number;
  errorCode?: string;
  at: string;
};

export const PROCESSING_STATUSES = [
  'queued',
  'normalizing',
  'waveform',
  'chunking',
  'completed',
  'failed',
] as const;
export type ProcessingStatus = (typeof PROCESSING_STATUSES)[number];

export type ProcessingStatusEvent = {
  organizationId: string;
  meetingId: string;
  recordingId: string;
  status: ProcessingStatus;
  /** 0..100 */
  percent?: number;
  errorCode?: string;
  at: string;
};

export interface MediaServerToClientEvents {
  'upload:status': (e: UploadStatusEvent) => void;
  'processing:status': (e: ProcessingStatusEvent) => void;
}

/** Everything the realtime server can emit: contracts events plus media status events. */
export type RealtimeServerToClientEvents = ServerToClientEvents &
  MediaServerToClientEvents &
  ControlServerToClientEvents;

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const CODE = /^[a-z0-9_]{1,64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const iso = (v: unknown) => typeof v === 'string' && v.length <= 40 && !Number.isNaN(Date.parse(v));
const optNum = (v: unknown, max: number) =>
  v === undefined || (typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max);
const optCode = (v: unknown) => v === undefined || (typeof v === 'string' && CODE.test(v));
const ids = (e: Record<string, unknown>, keys: string[]) =>
  keys.every((k) => typeof e[k] === 'string' && ID.test(e[k]));

/** Strict shape check for producers (rejects unknown keys so nothing sensitive leaks into a broadcast). */
export function isUploadStatusEvent(v: unknown): v is UploadStatusEvent {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  const allowed = new Set([
    'organizationId',
    'meetingId',
    'uploadId',
    'status',
    'sha256',
    'sizeBytes',
    'errorCode',
    'at',
  ]);
  if (Object.keys(e).some((k) => !allowed.has(k))) return false;
  return (
    ids(e, ['organizationId', 'meetingId', 'uploadId']) &&
    (UPLOAD_STATUSES as readonly unknown[]).includes(e.status) &&
    (e.sha256 === undefined || (typeof e.sha256 === 'string' && HEX64.test(e.sha256))) &&
    optNum(e.sizeBytes, Number.MAX_SAFE_INTEGER) &&
    optCode(e.errorCode) &&
    iso(e.at)
  );
}

export function isProcessingStatusEvent(v: unknown): v is ProcessingStatusEvent {
  if (!v || typeof v !== 'object') return false;
  const e = v as Record<string, unknown>;
  const allowed = new Set([
    'organizationId',
    'meetingId',
    'recordingId',
    'status',
    'percent',
    'errorCode',
    'at',
  ]);
  if (Object.keys(e).some((k) => !allowed.has(k))) return false;
  return (
    ids(e, ['organizationId', 'meetingId', 'recordingId']) &&
    (PROCESSING_STATUSES as readonly unknown[]).includes(e.status) &&
    optNum(e.percent, 100) &&
    optCode(e.errorCode) &&
    iso(e.at)
  );
}

/** Internal pipeline phases (not sent to clients as-is). */
export type PipelinePhase =
  | 'scheduled'
  | 'recording'
  | 'uploaded'
  | 'normalizing'
  | 'chunking'
  | 'transcribing'
  | 'merging'
  | 'completed'
  | 'failed';

/**
 * Map an internal pipeline phase to the contracts MeetingStatus plus an optional
 * transcription stage: uploaded/normalizing/chunking/transcribing/merging => processing.
 */
export function toMeetingStatus(phase: PipelinePhase): {
  status: MeetingStatus;
  stage?: TranscriptionStage;
} {
  switch (phase) {
    case 'uploaded':
      return { status: 'processing' };
    case 'normalizing':
    case 'chunking':
    case 'transcribing':
    case 'merging':
      return { status: 'processing', stage: phase };
    default:
      return { status: phase };
  }
}
