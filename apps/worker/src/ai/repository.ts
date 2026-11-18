import type { ChunkTranscript, TranscriptRevision, TranscriptStore } from '@meetops/ai-core';

/** `Meeting` row as visible inside withOrgContext (RLS). */
export type MeetingScope = { id: string; organizationId: string };

/** `Recording` row as visible inside withOrgContext (RLS). */
export type RecordingScope = {
  id: string;
  organizationId: string;
  meetingId: string;
  /** Total chunks Media produced, if persisted (enables percent + `complete`). */
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
  status: 'processing' | 'ready';
  language: string | null;
  fullText: string;
  segments: TranscriptSegmentRow[];
  /** Opaque merge state (content hash, chunk indexes, speaker map) the store needs to resume merging. */
  mergeState: TranscriptRevision;
};

/**
 * Org-scoped operations. Only reachable through `TranscriptRepository.withOrgContext`, so every DB access runs in
 * `@meetops/database` `withOrgContext(organizationId, tx => ...)` (one transaction, `app.current_org_id` set, forced RLS).
 * No method takes an organizationId: the scope is the transaction.
 */
export interface OrgScopedTranscriptRepository {
  findMeeting(meetingId: string): Promise<MeetingScope | undefined>;
  findRecording(recordingId: string): Promise<RecordingScope | undefined>;
  /** Per-chunk raw STT result. First write wins: false if one already exists for (recording, chunkIndex). */
  putChunkResult(meetingId: string, recordingId: string, chunk: ChunkTranscript): Promise<boolean>;
  getChunkResult(
    meetingId: string,
    recordingId: string,
    chunkIndex: number,
  ): Promise<ChunkTranscript | undefined>;
  listChunkResults(meetingId: string, recordingId: string): Promise<ChunkTranscript[]>;
  latestTranscript(meetingId: string, recordingId: string): Promise<TranscriptRevision | undefined>;
  /**
   * AssemblyAI (or other STT) job id stored on the revision-0 anchor (`transcripts.provider_job_id`).
   * Undefined on legacy rows where the column was never written. Kept for #513 compatibility.
   */
  getProviderJobId(meetingId: string, recordingId: string): Promise<string | undefined>;
  /**
   * Distinct STT job ids for this recording: `ChunkTranscript.providerJobId` from each
   * `transcript_chunks.segments` JSON, then the revision-0 anchor id if it is not already
   * in that list (legacy rows whose segments predate the field).
   */
  listProviderJobIds(meetingId: string, recordingId: string): Promise<string[]>;
  /**
   * Insert a `Transcript` row with `revision` and its `TranscriptSegment` rows, only if the latest revision equals
   * `expectedPrev` (compare-and-set; `@@unique([recordingId, revision])`). Returns false on conflict.
   */
  writeTranscriptRevision(write: TranscriptRevisionWrite, expectedPrev: number): Promise<boolean>;
}

/**
 * Persistence port for the AI transcription consumer. The production implementation (`createPrismaTranscriptRepository`)
 * wraps `withOrgContext` from the `@meetops/database` public entry only.
 */
export interface TranscriptRepository {
  withOrgContext<T>(
    organizationId: string,
    fn: (repo: OrgScopedTranscriptRepository) => Promise<T>,
  ): Promise<T>;
}

const ms = (sec: number) => Math.max(0, Math.round(sec * 1000));

/** Pure mapping from ai-core's merged revision to DB rows. */
export function toRevisionWrite(
  rev: TranscriptRevision,
  provider: string,
  language: string | undefined,
): TranscriptRevisionWrite {
  return {
    organizationId: rev.organizationId,
    meetingId: rev.meetingId,
    recordingId: rev.recordingId,
    provider,
    revision: rev.revision,
    status: rev.complete ? 'ready' : 'processing',
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

/** Adapts the repository to ai-core's `TranscriptStore`; each call is its own withOrgContext transaction. */
export class RepositoryTranscriptStore implements TranscriptStore {
  constructor(private readonly repo: TranscriptRepository) {}
  putChunk(t: string, m: string, r: string, c: ChunkTranscript) {
    return this.repo.withOrgContext(t, (x) => x.putChunkResult(m, r, c));
  }
  getChunk(t: string, m: string, r: string, i: number) {
    return this.repo.withOrgContext(t, (x) => x.getChunkResult(m, r, i));
  }
  listChunks(t: string, m: string, r: string) {
    return this.repo.withOrgContext(t, (x) => x.listChunkResults(m, r));
  }
  latestRevision(t: string, m: string, r: string) {
    return this.repo.withOrgContext(t, (x) => x.latestTranscript(m, r));
  }
  putRevision(rev: TranscriptRevision, expectedPrev: number) {
    return this.repo.withOrgContext(rev.organizationId, async (x) => {
      const chunks = await x.listChunkResults(rev.meetingId, rev.recordingId);
      const first = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex)[0];
      return x.writeTranscriptRevision(
        toRevisionWrite(rev, first?.provider ?? 'unknown', first?.language),
        expectedPrev,
      );
    });
  }
}

/** Recording-level transcription (one provider job per recording, stored as chunk 0) also records failure. */
export interface OrgScopedRecordingTranscriptRepository extends OrgScopedTranscriptRepository {
  /** Set the per-recording anchor transcript (revision 0) to `failed`. Idempotent. */
  markTranscriptFailed(meetingId: string, recordingId: string, provider: string): Promise<void>;
}

export interface RecordingTranscriptRepository {
  withOrgContext<T>(
    organizationId: string,
    fn: (repo: OrgScopedRecordingTranscriptRepository) => Promise<T>,
  ): Promise<T>;
}
