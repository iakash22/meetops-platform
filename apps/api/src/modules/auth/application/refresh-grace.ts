import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { RedisLike } from '../infrastructure/rate-limit/redis.js';

/** Server-side grace window for rotating refresh tokens (extension and desktop auth). */
export const REFRESH_GRACE_WINDOW_MS = 10_000;

type Entry<T> = { tokenHash: string; deviceId: string; at: number; pair: Promise<T> };

/**
 * Remembers, per token family, the refresh token most recently consumed and the pair it was rotated into. Presenting
 * that same token again from the same device within the window (a lost response, two tabs racing) gets the same new
 * pair back instead of tripping reuse detection. Anything older, from another device, or outside the window is still
 * treated as reuse. In-process only. Bounded: the oldest families are evicted beyond `maxFamilies`.
 */
export class RefreshGraceCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  constructor(
    private readonly windowMs = REFRESH_GRACE_WINDOW_MS,
    private readonly maxFamilies = 10_000,
  ) {}

  /** Record a rotation that is starting; settle it with the issued pair (or a failure). */
  begin(
    familyId: string,
    tokenHash: string,
    deviceId: string,
    at: number,
  ): { resolve(pair: T): void; reject(): void } {
    let resolve!: (pair: T) => void;
    let reject!: (err: Error) => void;
    const pair = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    pair.catch(() => undefined);
    this.entries.delete(familyId);
    while (this.entries.size >= this.maxFamilies)
      this.entries.delete(this.entries.keys().next().value as string);
    const entry: Entry<T> = { tokenHash, deviceId, at, pair };
    this.entries.set(familyId, entry);
    return {
      resolve,
      reject: () => {
        if (this.entries.get(familyId) === entry) this.entries.delete(familyId);
        reject(new Error('refresh failed'));
      },
    };
  }

  /** The pair to return again, or undefined when this is real reuse. */
  replay(
    familyId: string,
    tokenHash: string,
    deviceId: string,
    now: number,
  ): Promise<T> | undefined {
    const e = this.entries.get(familyId);
    if (!e || e.tokenHash !== tokenHash || e.deviceId !== deviceId) return undefined;
    if (now - e.at > this.windowMs || now < e.at) return undefined;
    return e.pair;
  }

  forget(familyId: string): void {
    this.entries.delete(familyId);
  }
}

export interface GraceHandle<T> {
  resolve(pair: T): Promise<void>;
  reject(): Promise<void>;
}

/**
 * Where the grace window lives. `secret` is the presented (plaintext) refresh token: stores may derive an encryption
 * key from it but must never persist it. `replay` returns the pair to hand back, `null` when the matching in-flight
 * rotation failed (answer 401 without revoking), or `undefined` when this is real reuse.
 */
export interface RefreshGraceStore<T> {
  begin(
    familyId: string,
    tokenHash: string,
    deviceId: string,
    secret: string,
  ): Promise<GraceHandle<T>>;
  replay(
    familyId: string,
    tokenHash: string,
    deviceId: string,
    secret: string,
  ): Promise<T | null | undefined>;
  forget(familyId: string): Promise<void>;
}

/** Single-instance store (development, tests, and the Redis store's fallback). */
export class MemoryRefreshGraceStore<T> implements RefreshGraceStore<T> {
  private readonly cache: RefreshGraceCache<T>;
  constructor(
    private readonly now: () => number = Date.now,
    windowMs = REFRESH_GRACE_WINDOW_MS,
  ) {
    this.cache = new RefreshGraceCache<T>(windowMs);
  }
  async begin(familyId: string, tokenHash: string, deviceId: string): Promise<GraceHandle<T>> {
    const h = this.cache.begin(familyId, tokenHash, deviceId, this.now());
    return { resolve: async (p) => h.resolve(p), reject: async () => h.reject() };
  }
  async replay(familyId: string, tokenHash: string, deviceId: string) {
    const p = this.cache.replay(familyId, tokenHash, deviceId, this.now());
    if (!p) return undefined;
    try {
      return await p;
    } catch {
      return null;
    }
  }
  async forget(familyId: string) {
    this.cache.forget(familyId);
  }
}

/** AES-256-GCM with a key derived from the refresh token that was presented; Redis never sees a usable token. */
const graceKey = (secret: string) =>
  createHash('sha256').update('meetops:refresh-grace:v1\0').update(secret).digest();

export function sealGracePair(value: unknown, secret: string, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', graceKey(secret), iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(JSON.stringify(value), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url');
}

export function openGracePair<T>(sealed: string, secret: string, aad: string): T | undefined {
  try {
    const b = Buffer.from(sealed, 'base64url');
    const d = createDecipheriv('aes-256-gcm', graceKey(secret), b.subarray(0, 12));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8')) as T;
  } catch {
    return undefined;
  }
}

type Rec = { s: 'pending' | 'done' | 'failed'; d: string; c?: string };

/**
 * Cluster-wide grace window: a retry that lands on any API instance gets the same pair. Per family, `<fam>:latest`
 * names the refresh token hash most recently rotated, and `<fam>:<hash>` holds its rotation, claimed atomically with
 * SET NX and a TTL of the window. The issued pair is stored only AES-GCM encrypted under a key derived from the old
 * refresh token (never stored), so Redis contents alone cannot be used. If Redis errors, it falls back to this
 * instance's memory store (same-instance retries still work; anything else is treated as reuse, i.e. fails closed).
 */
export class RedisRefreshGraceStore<T> implements RefreshGraceStore<T> {
  private readonly memory: MemoryRefreshGraceStore<T>;
  constructor(
    private readonly redis: RedisLike,
    private readonly prefix: string,
    private readonly opts: {
      windowMs?: number;
      now?: () => number;
      /** How long a retry waits for an in-flight rotation on another instance. */
      waitMs?: number;
      pollMs?: number;
    } = {},
  ) {
    this.memory = new MemoryRefreshGraceStore<T>(opts.now, this.windowMs);
  }
  private get windowMs() {
    return this.opts.windowMs ?? REFRESH_GRACE_WINDOW_MS;
  }
  private latestKey = (familyId: string) => `${this.prefix}${familyId}:latest`;
  private recKey = (familyId: string, tokenHash: string) =>
    `${this.prefix}${familyId}:${tokenHash}`;

  async begin(
    familyId: string,
    tokenHash: string,
    deviceId: string,
    secret: string,
  ): Promise<GraceHandle<T>> {
    const mem = await this.memory.begin(familyId, tokenHash, deviceId);
    const key = this.recKey(familyId, tokenHash);
    let claimed = false;
    try {
      const rec: Rec = { s: 'pending', d: deviceId };
      claimed = !!(await this.redis.set(key, JSON.stringify(rec), 'PX', this.windowMs, 'NX'));
      if (claimed) await this.redis.set(this.latestKey(familyId), tokenHash, 'PX', this.windowMs);
    } catch {
      claimed = false;
    }
    const write = async (rec: Rec) => {
      if (!claimed) return;
      try {
        const left = await this.redis.pttl(key);
        if (left > 0) await this.redis.set(key, JSON.stringify(rec), 'PX', left);
      } catch {
        // Memory fallback still has it.
      }
    };
    return {
      resolve: async (pair) => {
        await mem.resolve(pair);
        await write({
          s: 'done',
          d: deviceId,
          c: sealGracePair(pair, secret, `${familyId}:${tokenHash}`),
        });
      },
      reject: async () => {
        await mem.reject();
        await write({ s: 'failed', d: deviceId });
      },
    };
  }

  async replay(familyId: string, tokenHash: string, deviceId: string, secret: string) {
    const waitMs = this.opts.waitMs ?? 2_000;
    const pollMs = this.opts.pollMs ?? 50;
    try {
      if ((await this.redis.get(this.latestKey(familyId))) !== tokenHash) return undefined;
      const deadline = Date.now() + waitMs;
      for (;;) {
        const raw = await this.redis.get(this.recKey(familyId, tokenHash));
        if (!raw) return undefined;
        const rec = JSON.parse(raw) as Rec;
        if (rec.d !== deviceId) return undefined;
        if (rec.s === 'failed') return null;
        if (rec.s === 'done' && rec.c)
          return openGracePair<T>(rec.c, secret, `${familyId}:${tokenHash}`) ?? undefined;
        if (Date.now() >= deadline) return null;
        await new Promise((r) => setTimeout(r, pollMs));
      }
    } catch {
      return this.memory.replay(familyId, tokenHash, deviceId);
    }
  }

  async forget(familyId: string) {
    await this.memory.forget(familyId);
    try {
      await this.redis.del(this.latestKey(familyId));
    } catch {
      // The entry expires within the window anyway; the family is revoked in the token store.
    }
  }
}
