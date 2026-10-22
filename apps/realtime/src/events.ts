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
  TranscriptionStage
} from '@meetops/contracts';

export type {
  MeetingStatus,
  MeetingStatusEvent,
  ServerToClientEvents,
  TaskUpdateEvent,
  TranscriptionProgressEvent,
  TranscriptionStage
};
export { REALTIME_EVENTS } from '@meetops/contracts';

export type AckResult = { ok: true } | { ok: false; error: 'forbidden' | 'invalid' | 'error' };

export interface ClientToServerEvents {
  'meeting:join': (p: { meetingId: string }, ack: (r: AckResult) => void) => void;
  'meeting:leave': (p: { meetingId: string }, ack: (r: AckResult) => void) => void;
}

export type InterServerEvents = Record<string, never>;

export interface SocketData {
  userId: string;
  organizationId: string;
}

export const orgRoom = (organizationId: string) => `org:${organizationId}`;
/** Org-prefixed meeting room: org:{organizationId}:meeting:{meetingId}. */
export const meetingRoom = (organizationId: string, meetingId: string) => `org:${organizationId}:meeting:${meetingId}`;

/** Internal pipeline phases (not sent to clients as-is). */
export type PipelinePhase = 'scheduled' | 'recording' | 'uploaded' | 'normalizing' | 'chunking' | 'transcribing' | 'merging' | 'completed' | 'failed';

/**
 * Map an internal pipeline phase to the contracts MeetingStatus plus an optional
 * transcription stage: uploaded/normalizing/chunking/transcribing/merging => processing.
 */
export function toMeetingStatus(phase: PipelinePhase): { status: MeetingStatus; stage?: TranscriptionStage } {
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
