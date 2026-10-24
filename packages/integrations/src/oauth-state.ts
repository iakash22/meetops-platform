import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Single-use, TTL'd storage for OAuth `state`. `take` MUST atomically read and delete (Redis GETDEL). */
export interface OAuthStateStore {
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
  take(key: string): Promise<string | null>;
}

/** Minimal ioredis surface. */
export interface RedisStateClient {
  set(key: string, value: string, ex: 'EX', ttl: number, nx: 'NX'): Promise<'OK' | null>;
  getdel(key: string): Promise<string | null>;
}

export class RedisOAuthStateStore implements OAuthStateStore {
  constructor(
    private readonly redis: RedisStateClient,
    private readonly prefix = 'meetops:oauth:state:'
  ) {}
  async put(key: string, value: string, ttlSeconds: number) {
    const r = await this.redis.set(this.prefix + key, value, 'EX', ttlSeconds, 'NX');
    if (r !== 'OK') throw new Error('OAuth state collision');
  }
  async take(key: string) {
    return this.redis.getdel(this.prefix + key);
  }
}

export class InMemoryOAuthStateStore implements OAuthStateStore {
  private readonly m = new Map<string, { v: string; exp: number }>();
  constructor(private readonly now: () => number = Date.now) {}
  async put(key: string, value: string, ttlSeconds: number) {
    if (this.m.has(key)) throw new Error('OAuth state collision');
    this.m.set(key, { v: value, exp: this.now() + ttlSeconds * 1000 });
  }
  async take(key: string) {
    const e = this.m.get(key);
    this.m.delete(key);
    return e && e.exp > this.now() ? e.v : null;
  }
}

export interface OAuthStateBinding {
  provider: string;
  organizationId: string;
  userId: string;
  redirectUri: string;
}

export interface StoredOAuthState extends OAuthStateBinding {
  /** PKCE verifier (server-side only, never sent to the browser). */
  codeVerifier?: string;
  expiresAt: number;
}

export class OAuthStateError extends Error {
  constructor(readonly reason: 'invalid_state' | 'expired_state' | 'state_mismatch') {
    super(`OAuth state rejected: ${reason}`);
    this.name = 'OAuthStateError';
  }
}

export const DEFAULT_OAUTH_STATE_TTL_SECONDS = 600;
export const MAX_OAUTH_STATE_TTL_SECONDS = 900;
const STATE_RE = /^[A-Za-z0-9_-]{43}$/;

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();
/** Constant-time string equality (hash first so lengths always match). */
export function constantTimeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

export function randomUrlToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** PKCE (RFC 7636) S256 pair. Verifier: 32 random bytes -> 43 base64url chars. */
export function createPkcePair(): { codeVerifier: string; codeChallenge: string; method: 'S256' } {
  const codeVerifier = randomUrlToken(32);
  return { codeVerifier, codeChallenge: createHash('sha256').update(codeVerifier).digest('base64url'), method: 'S256' };
}

/**
 * State manager: 256-bit random state, stored under sha256(state) (the raw value never rests in Redis), bound to
 * provider+org+user+redirect, single use (atomic take), short TTL (<= 15 min), constant-time binding compare.
 */
export class OAuthStateManager {
  private readonly ttl: number;
  constructor(
    private readonly store: OAuthStateStore,
    opts: { ttlSeconds?: number; now?: () => number } = {}
  ) {
    this.ttl = Math.min(MAX_OAUTH_STATE_TTL_SECONDS, Math.max(60, opts.ttlSeconds ?? DEFAULT_OAUTH_STATE_TTL_SECONDS));
    this.now = opts.now ?? Date.now;
  }
  private readonly now: () => number;

  async issue(binding: OAuthStateBinding, codeVerifier?: string): Promise<string> {
    for (const k of ['provider', 'organizationId', 'userId', 'redirectUri'] as const) if (!binding[k]) throw new Error(`${k} is required`);
    const state = randomUrlToken(32);
    const rec: StoredOAuthState = { ...binding, expiresAt: this.now() + this.ttl * 1000 };
    if (codeVerifier) rec.codeVerifier = codeVerifier;
    await this.store.put(sha256(state).toString('hex'), JSON.stringify(rec), this.ttl);
    return state;
  }

  /** Consumes the state (even on mismatch, so it can never be retried) and checks the binding. */
  async consume(state: unknown, expected: OAuthStateBinding): Promise<StoredOAuthState> {
    if (typeof state !== 'string' || !STATE_RE.test(state)) throw new OAuthStateError('invalid_state');
    const raw = await this.store.take(sha256(state).toString('hex'));
    if (!raw) throw new OAuthStateError('invalid_state');
    let rec: StoredOAuthState;
    try {
      rec = JSON.parse(raw) as StoredOAuthState;
    } catch {
      throw new OAuthStateError('invalid_state');
    }
    if (!(rec.expiresAt > this.now())) throw new OAuthStateError('expired_state');
    let ok = true;
    for (const k of ['provider', 'organizationId', 'userId', 'redirectUri'] as const) ok = constantTimeEqual(String(rec[k] ?? ''), String(expected[k] ?? '')) && ok;
    if (!ok) throw new OAuthStateError('state_mismatch');
    return rec;
  }
}

/** Exact-match redirect allowlist (no prefix/wildcard matching). Only https, or http://localhost for dev. */
export function assertAllowedRedirect(redirectUri: string, allowlist: readonly string[]): void {
  if (!allowlist.includes(redirectUri)) throw new Error('redirect_uri not in allowlist');
  const u = new URL(redirectUri);
  const localhost = u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  if ((u.protocol !== 'https:' && !localhost) || u.hash || u.username || u.password) throw new Error('redirect_uri not allowed');
}
