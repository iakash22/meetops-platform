/** Server-side identity of this worker. Never derived from the job payload. */
export const TRANSCRIPTION_SYSTEM_ACTOR = { type: 'system', id: 'worker:transcription' } as const;
export type SystemActor = typeof TRANSCRIPTION_SYSTEM_ACTOR;

/** One audit entry per processed job: system actor id + organizationId, ids and codes only (no transcript text, no secrets). */
export type TranscriptionAuditEntry = {
  actor: SystemActor;
  organizationId: string;
  action: 'transcription.chunk';
  meetingId: string;
  recordingId: string;
  chunkIndex: number | undefined;
  jobId: string | undefined;
  outcome: 'succeeded' | 'duplicate' | 'rejected' | 'failed';
  errorCode?: string | undefined;
  provider?: string | undefined;
  revision?: number | undefined;
  at: string;
};

export interface TranscriptionAuditSink {
  record(entry: TranscriptionAuditEntry): void | Promise<void>;
}
