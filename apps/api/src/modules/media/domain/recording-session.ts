import type { AbortReason, RecordingSource } from '@meetops/contracts';
import { DomainError } from '../../../shared/domain-error.js';

export type RecordingSessionStatus = 'uploading' | 'completed' | 'aborted' | 'failed';

export interface RecordingChunkRecord {
  seq: number;
  sizeBytes: number;
  sha256Hex: string;
  key: string;
}

/** The slice of recording_sessions (+ recording_session_chunks) the session routes need. */
export interface RecordingSessionRecord {
  id: string;
  organizationId: string;
  meetingId: string;
  createdById: string;
  mimeType: string;
  source: RecordingSource;
  startedAt: Date;
  status: RecordingSessionStatus;
  /** Running sum of every signed chunk's sizeBytes. Never above MAX_RECORDING_SESSION_BYTES. */
  totalBytes: number;
  chunks: Map<number, RecordingChunkRecord>;
  chunkCount: number | null;
  durationMs: number | null;
  abortReason: AbortReason | null;
  createdAt: Date;
}

export type ReserveChunkResult = 'ok' | 'over_limit' | 'not_uploading';

export interface RecordingSessionRepository {
  create(r: RecordingSessionRecord): Promise<void>;
  /**
   * Org-scoped lookup (security review B 4.4): returns null for unknown ids and for sessions of another org. A
   * Prisma adapter MUST run this inside withOrganizationContext(organizationId) so forced RLS applies; callers still
   * compare organizationId as defense in depth.
   */
  findById(organizationId: string, id: string): Promise<RecordingSessionRecord | null>;
  /**
   * Atomically (re)reserve a chunk slot: replaces any previous signature for `seq` and keeps totalBytes the sum of all
   * reserved chunks. Refuses when the new total would exceed `maxTotalBytes` or the session is not uploading.
   */
  reserveChunk(
    organizationId: string,
    id: string,
    chunk: RecordingChunkRecord,
    maxTotalBytes: number,
  ): Promise<ReserveChunkResult>;
  /**
   * Moves an `uploading` session to `next`; false when it was no longer uploading. Prisma: `completed` also creates
   * the session's source FileObject + Recording (recording_sessions_completed_check needs recording_id).
   */
  finish(
    organizationId: string,
    id: string,
    next:
      | { status: 'completed'; chunkCount: number; durationMs: number }
      | { status: 'aborted'; abortReason: AbortReason },
  ): Promise<boolean>;
}

export class RecordingSessionNotFoundError extends DomainError {
  constructor() {
    super('NOT_FOUND', 'Recording session not found', 404);
  }
}
