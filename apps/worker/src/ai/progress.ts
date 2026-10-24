import type { TranscriptionProgressEvent } from '@meetops/contracts';

/**
 * Organization-scoped progress sink. In production this is Media's `createRealtimePublisher` (rooms
 * `org:{org}:meeting:{id}` + `org:{org}`, event `transcription:progress`), reused unmodified.
 */
export type TranscriptionProgressSink = { transcriptionProgress(e: TranscriptionProgressEvent): void };

/** Media publishes 85% / stage `transcribing` / chunksDone 0 after fan-out; the AI consumer owns 85..100. */
export const TRANSCRIBE_PROGRESS_START = 85;

export function chunkProgressEvent(q: {
  organizationId: string;
  meetingId: string;
  recordingId: string;
  chunksDone: number;
  chunksTotal?: number | undefined;
  complete: boolean;
  at: Date;
}): TranscriptionProgressEvent {
  const total = q.chunksTotal;
  const done = total !== undefined ? Math.min(q.chunksDone, total) : q.chunksDone;
  const span = 100 - TRANSCRIBE_PROGRESS_START;
  const percent = q.complete
    ? 100
    : total && total > 0
      ? Math.min(99, TRANSCRIBE_PROGRESS_START + Math.floor((done / total) * span))
      : TRANSCRIBE_PROGRESS_START;
  return {
    organizationId: q.organizationId,
    meetingId: q.meetingId,
    recordingId: q.recordingId,
    percent,
    stage: q.complete ? 'merging' : 'transcribing',
    chunksDone: done,
    ...(total !== undefined ? { chunksTotal: total } : {}),
    at: q.at.toISOString(),
  };
}
