import type { ChunkTranscript, TranscriptRevision, TranscriptStore } from '@meetops/ai-core';

/** Recording as seen by the transcription consumer, already filtered by organizationId. */
export type RecordingScope = {
  organizationId: string;
  meetingId: string;
  /** Total chunks Media produced, if Backend/Media persisted it (enables percent + `complete`). */
  chunkCount?: number | undefined;
};

/** One `TranscriptSegment` row (packages/database `transcript_segments`). Times in ms; `sequence` is 0-based. */
export type TranscriptSegmentRow = {
  sequence: number;
  speakerLabel: string | null;
  startMs: number;
  endMs: number;
  text: string;
  confidence: number | null;
};

/** One `Transcript` row (packages/database `transcripts`) plus its segments for that revision. */
export type TranscriptRevisionWrite = {
  organizationId: string;
  meetingId: string;
  recordingId: string;
  provider: string;
  revision: number;
  status: 'processing' | 'completed';
  language: string | null;
  fullText: string;
  segments: TranscriptSegmentRow[];
  /** Opaque merge state (content hash, chunk indexes, speaker map) the store needs to resume merging. */
  mergeState: TranscriptRevision;
};

/**
 * Persistence port for the AI transcription consumer. EVERY method is organization-scoped: an implementation must put
 * `organizationId` in the WHERE clause (never look a row up by id alone).
 *
 * Owned by Backend/DB. apps/worker has no Prisma client today, so only fakes implement this in-repo.
 */
export interface TranscriptRepository {
  /** Returns the recording only if it belongs to `organizationId`; undefined otherwise (treat as not found). */
  findRecording(organizationId: string, recordingId: string): Promise<RecordingScope | undefined>;
  /** Per-chunk raw STT result. First write wins: returns false if one already exists for (org, recording, chunkIndex). */
  putChunkResult(organizationId: string, meetingId: string, recordingId: string, chunk: ChunkTranscript): Promise<boolean>;
  getChunkResult(organizationId: string, meetingId: string, recordingId: string, chunkIndex: number): Promise<ChunkTranscript | undefined>;
  listChunkResults(organizationId: string, meetingId: string, recordingId: string): Promise<ChunkTranscript[]>;
  latestTranscript(organizationId: string, meetingId: string, recordingId: string): Promise<TranscriptRevision | undefined>;
  /**
   * Insert a `Transcript` row with `revision` and its `TranscriptSegment` rows in ONE transaction, only if the current
   * latest revision for the recording equals `expectedPrev` (compare-and-set; `@@unique([meetingId, revision])` backs it).
   * Returns false on conflict.
   */
  writeTranscriptRevision(write: TranscriptRevisionWrite, expectedPrev: number): Promise<boolean>;
}

const ms = (sec: number) => Math.max(0, Math.round(sec * 1000));

/** Pure mapping from ai-core's merged revision to DB rows. */
export function toRevisionWrite(rev: TranscriptRevision, provider: string, language: string | undefined): TranscriptRevisionWrite {
  return {
    organizationId: rev.organizationId,
    meetingId: rev.meetingId,
    recordingId: rev.recordingId,
    provider,
    revision: rev.revision,
    status: rev.complete ? 'completed' : 'processing',
    language: language ?? null,
    fullText: rev.text,
    segments: rev.segments.map((s, i) => ({
      sequence: i,
      speakerLabel: s.speaker ?? null,
      startMs: ms(s.startSec),
      endMs: Math.max(ms(s.startSec), ms(s.endSec)),
      text: s.text,
      confidence: s.confidence ?? null,
    })),
    mergeState: rev,
  };
}

/** Adapts the repository to ai-core's `TranscriptStore` so the existing `TranscriptionChunkHandler` can be reused. */
export class RepositoryTranscriptStore implements TranscriptStore {
  constructor(private readonly repo: TranscriptRepository) {}
  putChunk(t: string, m: string, r: string, c: ChunkTranscript) {
    return this.repo.putChunkResult(t, m, r, c);
  }
  getChunk(t: string, m: string, r: string, i: number) {
    return this.repo.getChunkResult(t, m, r, i);
  }
  listChunks(t: string, m: string, r: string) {
    return this.repo.listChunkResults(t, m, r);
  }
  latestRevision(t: string, m: string, r: string) {
    return this.repo.latestTranscript(t, m, r);
  }
  async putRevision(rev: TranscriptRevision, expectedPrev: number) {
    const chunks = await this.repo.listChunkResults(rev.organizationId, rev.meetingId, rev.recordingId);
    const first = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex)[0];
    return this.repo.writeTranscriptRevision(toRevisionWrite(rev, first?.provider ?? 'unknown', first?.language), expectedPrev);
  }
}
