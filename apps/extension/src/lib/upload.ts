/**
 * Client contract for the future chunked upload API. No real endpoint yet;
 * StubUploadClient keeps everything in memory.
 */
export interface UploadSessionMeta {
  mimeType: string;
  startedAt: number;
  source: "tab";
}

export interface UploadClient {
  initSession(meta: UploadSessionMeta): Promise<{ sessionId: string }>;
  /** seq starts at 0 and increases by 1 per chunk. */
  uploadChunk(sessionId: string, seq: number, data: Blob): Promise<void>;
  complete(sessionId: string, summary: { chunkCount: number; durationMs: number }): Promise<void>;
  abort?(sessionId: string, reason: string): Promise<void>;
}

export class StubUploadClient implements UploadClient {
  readonly sessions = new Map<
    string,
    { meta: UploadSessionMeta; chunks: Map<number, number>; completed?: { chunkCount: number; durationMs: number }; aborted?: string }
  >();
  private n = 0;

  async initSession(meta: UploadSessionMeta) {
    const sessionId = `stub-${++this.n}`;
    this.sessions.set(sessionId, { meta, chunks: new Map() });
    return { sessionId };
  }

  async uploadChunk(sessionId: string, seq: number, data: Blob) {
    const s = this.require(sessionId);
    if (s.completed) throw new Error("Session already completed");
    s.chunks.set(seq, data.size);
  }

  async complete(sessionId: string, summary: { chunkCount: number; durationMs: number }) {
    this.require(sessionId).completed = summary;
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

/** Serialises chunk uploads so seq order is preserved, even if a chunk fails. */
export class ChunkQueue {
  private seq = 0;
  private tail: Promise<void> = Promise.resolve();
  private failed: unknown;

  constructor(
    private readonly client: UploadClient,
    private readonly sessionId: string,
    private readonly onUploaded?: (seq: number) => void
  ) {}

  push(data: Blob): void {
    const seq = this.seq++;
    this.tail = this.tail.then(async () => {
      if (this.failed) return;
      try {
        await this.client.uploadChunk(this.sessionId, seq, data);
        this.onUploaded?.(seq);
      } catch (err) {
        this.failed = err;
      }
    });
  }

  get count(): number {
    return this.seq;
  }

  /** Wait for all queued uploads; throws the first upload error. */
  async flush(): Promise<void> {
    await this.tail;
    if (this.failed) throw this.failed instanceof Error ? this.failed : new Error("Chunk upload failed");
  }
}
