import type { RecordingStatus } from './contracts.js';

/**
 * Client contract for the future chunked upload API. No real endpoint yet;
 * StubUploadClient keeps everything in memory.
 */
export interface UploadSessionMeta {
  mimeType: string;
  startedAt: number;
  source: 'tab';
}

export interface UploadSummary {
  chunkCount: number;
  durationMs: number;
}

export interface UploadClient {
  /**
   * True when a successful uploadChunk means the server durably has the data, so the
   * local copy may be deleted. The stub is not durable: chunks stay in IndexedDB.
   */
  readonly durable: boolean;
  initSession(meta: UploadSessionMeta): Promise<{ sessionId: string }>;
  /** Re-attach to a session created before a restart (idempotent). */
  resumeSession(sessionId: string, meta: UploadSessionMeta): Promise<void>;
  /** seq starts at 0 and increases by 1 per chunk. Must be idempotent per (sessionId, seq). */
  uploadChunk(sessionId: string, seq: number, data: Blob): Promise<void>;
  complete(sessionId: string, summary: UploadSummary): Promise<{ status: RecordingStatus }>;
  abort?(sessionId: string, reason: string): Promise<void>;
}

interface StubSession {
  meta: UploadSessionMeta;
  chunks: Map<number, number>;
  completed?: UploadSummary;
  aborted?: string;
}

export class StubUploadClient implements UploadClient {
  readonly durable = false;
  readonly sessions = new Map<string, StubSession>();

  constructor(private readonly newId: () => string = () => `stub-${crypto.randomUUID()}`) {}

  async initSession(meta: UploadSessionMeta) {
    const sessionId = this.newId();
    this.sessions.set(sessionId, { meta, chunks: new Map() });
    return { sessionId };
  }

  async resumeSession(sessionId: string, meta: UploadSessionMeta) {
    if (!this.sessions.has(sessionId)) this.sessions.set(sessionId, { meta, chunks: new Map() });
  }

  async uploadChunk(sessionId: string, seq: number, data: Blob) {
    const s = this.require(sessionId);
    if (s.completed) throw new Error('Session already completed');
    s.chunks.set(seq, data.size);
  }

  async complete(sessionId: string, summary: UploadSummary) {
    this.require(sessionId).completed = summary;
    return { status: 'uploaded' as const };
  }

  async abort(sessionId: string, reason: string) {
    this.require(sessionId).aborted = reason;
  }

  private require(id: string) {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`Unknown upload session ${id}`);
    return s;
  }
}
