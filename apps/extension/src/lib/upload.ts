import {
  CHUNK_UPLOAD_URL_TTL_SECONDS,
  MAX_CHUNK_BYTES,
  MAX_RECORDING_CHUNKS,
  type AbortRecordingSessionRequest,
  type ChunkUploadUrlRequest,
  type ChunkUploadUrlResponse,
  type CompleteRecordingSessionRequest,
  type CompleteRecordingSessionResponse,
  type InitRecordingSessionRequest,
  type InitRecordingSessionResponse,
} from './contracts.js';

/**
 * Client for the chunked recording upload API (contracts v0.2):
 * init -> per chunk: request presigned PUT URL (300 s TTL) and PUT the bytes -> complete | abort.
 * No real endpoint yet; StubUploadClient simulates the server and presigned URLs in memory.
 */
export interface UploadClient {
  /**
   * True when a successful PUT means the server durably has the data, so the local copy may be
   * deleted. The stub is not durable: chunks stay in IndexedDB.
   */
  readonly durable: boolean;
  initSession(req: InitRecordingSessionRequest): Promise<InitRecordingSessionResponse>;
  /** Issue a presigned PUT URL for one chunk. Idempotent per (sessionId, seq); may be re-requested. */
  requestChunkUrl(sessionId: string, req: ChunkUploadUrlRequest): Promise<ChunkUploadUrlResponse>;
  /** PUT the bytes to a presigned URL. Throws UploadUrlExpiredError if the URL has expired. */
  putChunk(upload: ChunkUploadUrlResponse['upload'], data: Blob): Promise<void>;
  complete(
    sessionId: string,
    req: CompleteRecordingSessionRequest,
  ): Promise<CompleteRecordingSessionResponse>;
  abort(sessionId: string, req: AbortRecordingSessionRequest): Promise<void>;
}

export class UploadUrlExpiredError extends Error {
  constructor() {
    super('Presigned upload URL expired');
    this.name = 'UploadUrlExpiredError';
  }
}

/** Refresh a URL that expires within this margin rather than racing the PUT against expiry. */
export const URL_EXPIRY_SKEW_MS = 10_000;

/** Convert an epoch-ms number (pre-v0.2 records) or ISO string to an ISO 8601 string. */
export function toIsoTimestamp(v: string | number): string {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid timestamp: ${String(v)}`);
  return d.toISOString();
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Split bytes into parts of at most MAX_CHUNK_BYTES (server concatenates parts in seq order). */
export function splitForUpload(data: ArrayBuffer, max: number = MAX_CHUNK_BYTES): ArrayBuffer[] {
  if (data.byteLength <= max) return [data];
  const parts: ArrayBuffer[] = [];
  for (let off = 0; off < data.byteLength; off += max) parts.push(data.slice(off, off + max));
  return parts;
}

/**
 * Upload one chunk: get a presigned URL, refresh it if expired (or about to), PUT the bytes,
 * and if the PUT reports expiry, refresh once and retry.
 */
export async function uploadChunk(
  client: UploadClient,
  sessionId: string,
  seq: number,
  data: Blob,
  now: () => number = Date.now,
): Promise<void> {
  if (data.size > MAX_CHUNK_BYTES) throw new Error(`Chunk ${seq} exceeds ${MAX_CHUNK_BYTES} bytes`);
  if (!Number.isInteger(seq) || seq < 0 || seq >= MAX_RECORDING_CHUNKS) {
    throw new Error(`Chunk seq ${seq} out of range`);
  }
  const fresh = async () => {
    let res = await client.requestChunkUrl(sessionId, { seq });
    if (Date.parse(res.upload.expiresAt) - now() <= URL_EXPIRY_SKEW_MS) {
      res = await client.requestChunkUrl(sessionId, { seq });
    }
    return res.upload;
  };
  try {
    await client.putChunk(await fresh(), data);
  } catch (err) {
    if (!(err instanceof UploadUrlExpiredError)) throw err;
    await client.putChunk(await fresh(), data);
  }
}

interface StubSession {
  req: InitRecordingSessionRequest;
  chunks: Map<number, number>;
  completed?: CompleteRecordingSessionRequest;
  aborted?: AbortRecordingSessionRequest['reason'];
}

/** In-memory simulation of the v0.2 server, including presigned URL expiry. */
export class StubUploadClient implements UploadClient {
  readonly durable: boolean = false;
  readonly sessions = new Map<string, StubSession>();
  /** url -> {sessionId, seq, expiresAtMs} */
  readonly issued = new Map<string, { sessionId: string; seq: number; expiresAtMs: number }>();

  constructor(
    private readonly opts: {
      newId?: () => string;
      now?: () => number;
      ttlSeconds?: number;
    } = {},
  ) {}

  private get now() {
    return this.opts.now ?? Date.now;
  }

  async initSession(req: InitRecordingSessionRequest) {
    if (Number.isNaN(Date.parse(req.startedAt))) throw new Error('startedAt must be ISO 8601');
    const sessionId = (this.opts.newId ?? (() => crypto.randomUUID()))();
    this.sessions.set(sessionId, { req, chunks: new Map() });
    return { sessionId };
  }

  async requestChunkUrl(sessionId: string, req: ChunkUploadUrlRequest) {
    // The real server knows sessions created before an extension restart; so does the stub.
    const s = this.sessionFor(sessionId);
    if (s.completed || s.aborted) throw new Error('Session is closed');
    const ttl = (this.opts.ttlSeconds ?? CHUNK_UPLOAD_URL_TTL_SECONDS) * 1000;
    const expiresAtMs = this.now() + ttl;
    const url = `https://uploads.stub.invalid/recording-sessions/${sessionId}/chunks/${req.seq}?sig=${crypto.randomUUID()}`;
    this.issued.set(url, { sessionId, seq: req.seq, expiresAtMs });
    return {
      seq: req.seq,
      upload: {
        url,
        method: 'PUT' as const,
        headers: { 'content-type': 'application/octet-stream' },
        expiresAt: new Date(expiresAtMs).toISOString(),
      },
    };
  }

  async putChunk(upload: ChunkUploadUrlResponse['upload'], data: Blob) {
    const grant = this.issued.get(upload.url);
    if (!grant) throw new Error('Unknown presigned URL');
    if (this.now() >= grant.expiresAtMs) throw new UploadUrlExpiredError();
    if (data.size > MAX_CHUNK_BYTES) throw new Error('Chunk too large');
    this.sessionFor(grant.sessionId).chunks.set(grant.seq, data.size);
  }

  async complete(sessionId: string, req: CompleteRecordingSessionRequest) {
    const s = this.sessionFor(sessionId);
    if (req.chunkCount < 1) throw new Error('chunkCount must be >= 1; abort empty sessions');
    s.completed = req;
    return { status: 'uploaded' as const };
  }

  async abort(sessionId: string, req: AbortRecordingSessionRequest) {
    this.sessionFor(sessionId).aborted = req.reason;
  }

  private sessionFor(id: string): StubSession {
    let s = this.sessions.get(id);
    if (!s) {
      s = {
        req: { mimeType: 'audio/webm', startedAt: new Date(0).toISOString(), source: 'tab' },
        chunks: new Map(),
      };
      this.sessions.set(id, s);
    }
    return s;
  }
}
