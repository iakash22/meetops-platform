import type { ChunkTranscript, MergedTranscript } from './merge.js';

export type TranscriptRevision = MergedTranscript & {
  tenantId: string;
  meetingId: string;
  recordingId: string;
  revision: number;
  /** Hash of segment content; a new revision is written only when this changes. */
  contentHash: string;
  createdAt: string;
};

/** Persistence for chunk results + transcript revisions. Backend/DB provides the durable, tenant-scoped implementation. */
export interface TranscriptStore {
  /** Returns false if a result for this chunk already exists (first write wins). */
  putChunk(tenantId: string, meetingId: string, recordingId: string, chunk: ChunkTranscript): Promise<boolean>;
  getChunk(tenantId: string, meetingId: string, recordingId: string, chunkIndex: number): Promise<ChunkTranscript | undefined>;
  listChunks(tenantId: string, meetingId: string, recordingId: string): Promise<ChunkTranscript[]>;
  latestRevision(tenantId: string, meetingId: string, recordingId: string): Promise<TranscriptRevision | undefined>;
  /** Must be compare-and-set on revision (expectedPrev) to avoid lost updates under concurrent chunk completion. */
  putRevision(rev: TranscriptRevision, expectedPrev: number): Promise<boolean>;
}

const k = (t: string, m: string, r: string) => `${t}\u0000${m}\u0000${r}`;

export class InMemoryTranscriptStore implements TranscriptStore {
  private readonly chunks = new Map<string, Map<number, ChunkTranscript>>();
  private readonly revs = new Map<string, TranscriptRevision[]>();
  async putChunk(t: string, m: string, r: string, c: ChunkTranscript) {
    const map = this.chunks.get(k(t, m, r)) ?? new Map<number, ChunkTranscript>();
    this.chunks.set(k(t, m, r), map);
    if (map.has(c.chunkIndex)) return false;
    map.set(c.chunkIndex, structuredClone(c));
    return true;
  }
  async getChunk(t: string, m: string, r: string, i: number) {
    return this.chunks.get(k(t, m, r))?.get(i);
  }
  async listChunks(t: string, m: string, r: string) {
    return [...(this.chunks.get(k(t, m, r))?.values() ?? [])].map((c) => structuredClone(c));
  }
  async latestRevision(t: string, m: string, r: string) {
    const l = this.revs.get(k(t, m, r));
    return l?.[l.length - 1];
  }
  async putRevision(rev: TranscriptRevision, expectedPrev: number) {
    const key = k(rev.tenantId, rev.meetingId, rev.recordingId);
    const l = this.revs.get(key) ?? [];
    if ((l[l.length - 1]?.revision ?? 0) !== expectedPrev) return false;
    l.push(structuredClone(rev));
    this.revs.set(key, l);
    return true;
  }
  revisions(t: string, m: string, r: string) {
    return this.revs.get(k(t, m, r)) ?? [];
  }
}
