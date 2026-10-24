import { randomBytes } from 'node:crypto';

/** Server-side record of one issued presigned upload. */
export type UploadTokenRecord = {
  /** Object key the token was issued for. */
  key: string;
  /** Base64 sha256 signed into the upload. */
  checksumSha256: string;
  /** Declared size in bytes (whole object). */
  sizeBytes: number;
  /** Multipart upload id, when the token belongs to a multipart upload. */
  uploadId?: string;
};

/**
 * One-time upload tokens. Implementations MUST make `consume` atomic (get + delete in one step) so two concurrent
 * confirms cannot both succeed. The in-memory store is per process: use a shared store (e.g. Redis) when more than
 * one API instance issues or confirms uploads.
 */
export interface UploadTokenStore {
  /** Record a new token for `ttlSeconds`. Returns false if the token already exists. */
  issue(token: string, record: UploadTokenRecord, ttlSeconds: number): Promise<boolean>;
  /** Atomically fetch and delete. Returns null when unknown, expired or already consumed. */
  consume(token: string): Promise<UploadTokenRecord | null>;
}

export const UPLOAD_TOKEN_METADATA_KEY = 'upload-token';
export const UPLOAD_TOKEN_HEADER = `x-amz-meta-${UPLOAD_TOKEN_METADATA_KEY}`;
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;

/** 24 random bytes as base64url (32 chars, 192 bits). */
export function newUploadToken(): string {
  return randomBytes(24).toString('base64url');
}

export function isUploadToken(v: unknown): v is string {
  return typeof v === 'string' && TOKEN_RE.test(v);
}

export class InMemoryUploadTokenStore implements UploadTokenStore {
  readonly #m = new Map<string, { rec: UploadTokenRecord; exp: number }>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  async issue(token: string, record: UploadTokenRecord, ttlSeconds: number): Promise<boolean> {
    this.#sweep();
    if (this.#m.has(token)) return false;
    this.#m.set(token, { rec: { ...record }, exp: this.#now() + ttlSeconds * 1000 });
    return true;
  }

  async consume(token: string): Promise<UploadTokenRecord | null> {
    const e = this.#m.get(token);
    this.#m.delete(token);
    if (!e || e.exp <= this.#now()) return null;
    return e.rec;
  }

  get size(): number {
    this.#sweep();
    return this.#m.size;
  }

  #sweep(): void {
    const now = this.#now();
    for (const [k, v] of this.#m) if (v.exp <= now) this.#m.delete(k);
  }
}

/** Minimal Redis surface (ioredis-compatible): SET key val EX ttl NX, and GETDEL (Redis >= 6.2). */
export interface RedisLikeClient {
  set(key: string, value: string, ex: 'EX', ttlSeconds: number, nx: 'NX'): Promise<string | null>;
  getdel(key: string): Promise<string | null>;
}

export class RedisUploadTokenStore implements UploadTokenStore {
  constructor(
    private readonly redis: RedisLikeClient,
    private readonly prefix = 'meetops:upload-token:'
  ) {}

  async issue(token: string, record: UploadTokenRecord, ttlSeconds: number): Promise<boolean> {
    return (await this.redis.set(this.prefix + token, JSON.stringify(record), 'EX', ttlSeconds, 'NX')) === 'OK';
  }

  async consume(token: string): Promise<UploadTokenRecord | null> {
    const raw = await this.redis.getdel(this.prefix + token);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as UploadTokenRecord;
    } catch {
      return null;
    }
  }
}
