import {
  CHUNK_UPLOAD_URL_TTL_SECONDS,
  MAX_CHUNK_BYTES,
  MAX_CHUNKS,
  type AbortRecordingSessionRequest,
  type ChunkUploadUrlRequest,
  type ChunkUploadUrlResponse,
  type CompleteRecordingSessionRequest,
  type CompleteRecordingSessionResponse,
  type InitRecordingSessionRequest,
  type InitRecordingSessionResponse,
} from './contracts.js';

/** One HTTP PUT to object storage via a presigned URL. Implementations must send `headers` as given. */
export interface StoragePutRequest {
  url: string;
  method: 'PUT';
  headers: Record<string, string>;
  body: Blob;
}
export type StorageTransport = (req: StoragePutRequest) => Promise<{ status: number }>;

/**
 * Client for the chunked recording upload API (contracts v0.2):
 * init -> per chunk: request a presigned PUT (signed size + sha256, 300 s TTL), PUT the bytes with
 * the signed headers -> complete | abort. No real endpoint yet; StubUploadClient simulates it.
 */
export interface UploadClient {
  /**
   * True when a successful PUT means the server durably has the data, so the local copy may be
   * deleted. The stub is not durable: chunks stay in IndexedDB.
   */
  readonly durable: boolean;
  initSession(req: InitRecordingSessionRequest): Promise<InitRecordingSessionResponse>;
  /** Issue a presigned PUT for one chunk. May be re-requested (refresh). */
  requestChunkUrl(sessionId: string, req: ChunkUploadUrlRequest): Promise<ChunkUploadUrlResponse>;
  /** Storage PUT (fetchTransport in production). */
  readonly storage: StorageTransport;
  complete(
    sessionId: string,
    req: CompleteRecordingSessionRequest,
  ): Promise<CompleteRecordingSessionResponse>;
  abort(sessionId: string, req: AbortRecordingSessionRequest): Promise<void>;
}

export class UploadUrlExpiredError extends Error {
  constructor() {
    super('Presigned upload URL expired or was rejected (403)');
    this.name = 'UploadUrlExpiredError';
  }
}

/** Refresh a URL that expires within this margin rather than racing the PUT against expiry. */
export const URL_EXPIRY_SKEW_MS = 10_000;

/**
 * Only HTTPS upload targets are allowed. Plain http is accepted for localhost / 127.0.0.1 only
 * when allowLocalHttp is set (dev builds), so a local stub/minio can be used during development.
 */
export function assertSafeUploadUrl(url: string, allowLocalHttp: boolean): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('Upload URL is not a valid URL');
  }
  if (u.protocol === 'https:') return;
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (u.protocol === 'http:' && local && allowLocalHttp) return;
  throw new Error(`Refusing non-HTTPS upload URL (${u.protocol}//${u.host})`);
}

/**
 * Browser fetch transport. `Content-Length` is a forbidden request header in fetch: the browser
 * sets it from the Blob body, which is exactly the signed sizeBytes, so it is not passed explicitly
 * (uploadChunk has already checked that the signed value equals the body size).
 */
export function createFetchTransport(opts: { allowLocalHttp: boolean }): StorageTransport {
  return async (req) => {
    assertSafeUploadUrl(req.url, opts.allowLocalHttp);
    const headers = Object.fromEntries(
      Object.entries(req.headers).filter(([k]) => k.toLowerCase() !== 'content-length'),
    );
    const res = await fetch(req.url, {
      method: req.method,
      headers,
      body: req.body,
      redirect: 'error',
    });
    return { status: res.status };
  };
}

export const fetchTransport: StorageTransport = createFetchTransport({
  allowLocalHttp: import.meta.env.DEV,
});

/**
 * Validate the headers the API signed into a presigned PUT (case-insensitive): content-length must
 * be present and equal the body size, and x-amz-checksum-sha256 must be present and match when a
 * sha256 was sent. Anything else means the URL was not signed for this body; refuse to upload.
 */
export function checkSignedHeaders(
  headers: Record<string, string> | undefined,
  sizeBytes: number,
  sha256: string | undefined,
): Record<string, string> {
  const h = headers ?? {};
  const get = (name: string) => Object.entries(h).find(([k]) => k.toLowerCase() === name)?.[1];
  const len = get('content-length');
  if (len === undefined) throw new Error('Presigned upload is missing signed content-length');
  if (len.trim() !== String(sizeBytes)) {
    throw new Error(`Signed content-length ${len} does not match chunk size ${sizeBytes}`);
  }
  if (sha256 !== undefined) {
    const sum = get('x-amz-checksum-sha256');
    if (sum === undefined) {
      throw new Error('Presigned upload is missing signed x-amz-checksum-sha256');
    }
    if (sum !== hexToBase64(sha256))
      throw new Error('Signed x-amz-checksum-sha256 does not match chunk');
  }
  return h;
}

/** Convert an epoch-ms number (pre-v0.2 records) or ISO string to an ISO 8601 string. */
export function toIsoTimestamp(v: string | number): string {
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error(`Invalid timestamp: ${String(v)}`);
  return d.toISOString();
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Lowercase hex SHA-256, as the contract's Sha256Hex requires. */
export async function sha256Hex(data: ArrayBuffer | Blob): Promise<string> {
  const buf = data instanceof Blob ? await data.arrayBuffer() : data;
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function hexToBase64(hex: string): string {
  const bytes = hex.match(/../g)!.map((h) => parseInt(h, 16));
  return btoa(String.fromCharCode(...bytes));
}

/** Split bytes into parts of at most MAX_CHUNK_BYTES (server concatenates parts in seq order). */
export function splitForUpload(data: ArrayBuffer, max: number = MAX_CHUNK_BYTES): ArrayBuffer[] {
  if (data.byteLength <= max) return [data];
  const parts: ArrayBuffer[] = [];
  for (let off = 0; off < data.byteLength; off += max) parts.push(data.slice(off, off + max));
  return parts;
}

/**
 * Upload one chunk: request a presigned PUT signed for its size and sha256, refresh the URL if it
 * expires within URL_EXPIRY_SKEW_MS, PUT with exactly the signed headers. A 403 from storage means
 * an expired/invalid signature: refresh the URL and retry once; a second 403 throws
 * UploadUrlExpiredError. Returns the digest for the complete() call.
 */
export async function uploadChunk(
  client: UploadClient,
  sessionId: string,
  seq: number,
  data: Blob,
  now: () => number = Date.now,
  knownSha256?: string,
): Promise<{ seq: number; sha256: string; sizeBytes: number }> {
  if (data.size < 1 || data.size > MAX_CHUNK_BYTES) {
    throw new Error(`Chunk ${seq} size ${data.size} outside 1..${MAX_CHUNK_BYTES} bytes`);
  }
  if (!Number.isInteger(seq) || seq < 0 || seq >= MAX_CHUNKS) {
    throw new Error(`Chunk seq ${seq} out of range`);
  }
  const sha256 = knownSha256 ?? (await sha256Hex(data));
  const req: ChunkUploadUrlRequest = { seq, sizeBytes: data.size, sha256 };
  const fresh = async () => {
    let res = await client.requestChunkUrl(sessionId, req);
    if (Date.parse(res.upload.expiresAt) - now() <= URL_EXPIRY_SKEW_MS) {
      res = await client.requestChunkUrl(sessionId, req);
    }
    return res.upload;
  };
  const put = async () => {
    const u = await fresh();
    const { status } = await client.storage({
      url: u.url,
      method: 'PUT',
      headers: checkSignedHeaders(u.headers, data.size, sha256),
      body: data,
    });
    if (status === 403) throw new UploadUrlExpiredError();
    if (status < 200 || status >= 300) throw new Error(`Storage PUT failed with HTTP ${status}`);
  };
  try {
    await put();
  } catch (err) {
    if (!(err instanceof UploadUrlExpiredError)) throw err;
    await put();
  }
  return { seq, sha256, sizeBytes: data.size };
}

interface StubSession {
  req: InitRecordingSessionRequest;
  chunks: Map<number, { sizeBytes: number; sha256: string }>;
  completed?: CompleteRecordingSessionRequest;
  aborted?: AbortRecordingSessionRequest['reason'];
}

interface Grant {
  sessionId: string;
  seq: number;
  expiresAtMs: number;
  headers: Record<string, string>;
}

/**
 * In-memory simulation of the v0.2 server and an S3-style store: signs Content-Length and
 * x-amz-checksum-sha256 (base64) into each presigned URL, and answers 403 for expired URLs or
 * headers/body that don't match the signature.
 */
export class StubUploadClient implements UploadClient {
  readonly durable: boolean = false;
  readonly sessions = new Map<string, StubSession>();
  readonly issued = new Map<string, Grant>();
  readonly puts: StoragePutRequest[] = [];

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
    if (!UUID_RE.test(req.meetingId)) throw new Error('meetingId must be a UUID');
    const sessionId = (this.opts.newId ?? (() => crypto.randomUUID()))();
    this.sessions.set(sessionId, { req, chunks: new Map() });
    return { sessionId };
  }

  async requestChunkUrl(sessionId: string, req: ChunkUploadUrlRequest) {
    // The real server knows sessions created before an extension restart; so does the stub.
    const s = this.sessionFor(sessionId);
    if (s.completed || s.aborted) throw new Error('Session is closed');
    if (!Number.isInteger(req.sizeBytes) || req.sizeBytes < 1 || req.sizeBytes > MAX_CHUNK_BYTES) {
      throw new Error('sizeBytes out of range');
    }
    if (req.sha256 !== undefined && !/^[0-9a-f]{64}$/.test(req.sha256)) {
      throw new Error('sha256 must be lowercase hex');
    }
    const ttl = (this.opts.ttlSeconds ?? CHUNK_UPLOAD_URL_TTL_SECONDS) * 1000;
    const expiresAtMs = this.now() + ttl;
    const url = `https://uploads.stub.invalid/recording-sessions/${sessionId}/chunks/${req.seq}?sig=${crypto.randomUUID()}`;
    const headers: { 'content-length': string; 'x-amz-checksum-sha256'?: string } = {
      'content-length': String(req.sizeBytes),
    };
    if (req.sha256) headers['x-amz-checksum-sha256'] = hexToBase64(req.sha256);
    this.issued.set(url, { sessionId, seq: req.seq, expiresAtMs, headers });
    return {
      seq: req.seq,
      upload: {
        url,
        method: 'PUT' as const,
        headers,
        expiresAt: new Date(expiresAtMs).toISOString(),
      },
    };
  }

  readonly storage: StorageTransport = async (req) => {
    this.puts.push(req);
    const grant = this.issued.get(req.url);
    if (!grant || this.now() >= grant.expiresAtMs) return { status: 403 };
    const sent = Object.fromEntries(
      Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), v]),
    );
    for (const [k, v] of Object.entries(grant.headers)) {
      if (sent[k.toLowerCase()] !== v) return { status: 403 }; // SignatureDoesNotMatch
    }
    if (String(req.body.size) !== grant.headers['content-length']) return { status: 400 };
    const sha = await sha256Hex(req.body);
    const signed = grant.headers['x-amz-checksum-sha256'];
    if (signed !== undefined && hexToBase64(sha) !== signed) return { status: 400 };
    this.sessionFor(grant.sessionId).chunks.set(grant.seq, {
      sizeBytes: req.body.size,
      sha256: sha,
    });
    return { status: 200 };
  };

  async complete(sessionId: string, req: CompleteRecordingSessionRequest) {
    const s = this.sessionFor(sessionId);
    if (req.chunkCount < 1) throw new Error('chunkCount must be >= 1; abort empty sessions');
    for (let seq = 0; seq < req.chunkCount; seq++) {
      if (!s.chunks.has(seq)) throw new Error(`Missing chunk ${seq}`);
    }
    if (s.chunks.size !== req.chunkCount) throw new Error('Unexpected extra chunks');
    for (const c of req.chunks ?? []) {
      if (s.chunks.get(c.seq)?.sha256 !== c.sha256)
        throw new Error(`Checksum mismatch at ${c.seq}`);
    }
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
        req: {
          mimeType: 'audio/webm',
          startedAt: new Date(0).toISOString(),
          source: 'tab',
          meetingId: '00000000-0000-4000-8000-000000000000',
        },
        chunks: new Map(),
      };
      this.sessions.set(id, s);
    }
    return s;
  }
}
