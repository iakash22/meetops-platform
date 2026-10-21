/**
 * Realtime event contracts. Defined locally because @meetops/contracts has no
 * meeting/transcription/task event types yet; move them there when it does.
 */
export type MeetingStatus = 'scheduled' | 'recording' | 'uploaded' | 'processing' | 'transcribing' | 'completed' | 'failed';

export type MeetingStatusEvent = {
  meetingId: string;
  orgId: string;
  status: MeetingStatus;
  at: string;
  error?: string;
};

export type TranscriptionProgressEvent = {
  meetingId: string;
  orgId: string;
  /** 0..100 */
  percent: number;
  chunksDone?: number;
  chunksTotal?: number;
  stage?: 'normalizing' | 'chunking' | 'transcribing' | 'merging';
  at: string;
};

export type TaskUpdateEvent = {
  taskId: string;
  meetingId?: string;
  orgId: string;
  status: 'open' | 'in_progress' | 'done' | 'cancelled';
  title?: string;
  assigneeId?: string;
  at: string;
};

export type AckResult = { ok: true } | { ok: false; error: 'forbidden' | 'invalid' | 'error' };

export interface ServerToClientEvents {
  'meeting:status': (e: MeetingStatusEvent) => void;
  'transcription:progress': (e: TranscriptionProgressEvent) => void;
  'task:update': (e: TaskUpdateEvent) => void;
}

export interface ClientToServerEvents {
  'meeting:join': (p: { meetingId: string }, ack: (r: AckResult) => void) => void;
  'meeting:leave': (p: { meetingId: string }, ack: (r: AckResult) => void) => void;
}

export type InterServerEvents = Record<string, never>;

export interface SocketData {
  userId: string;
  orgId: string;
}

export const orgRoom = (orgId: string) => `org:${orgId}`;
export const meetingRoom = (meetingId: string) => `meeting:${meetingId}`;
