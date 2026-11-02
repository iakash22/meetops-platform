import { randomUUID } from 'node:crypto';

/**
 * Integration token-refresh lease, shared by every path that refreshes a connection's provider tokens: the
 * apps/worker sweep and the apps/api on-demand refresh (Jira issue push). Both MUST take the same per-connection
 * key (tokenRefreshLeaseKey) so a rotating refresh never runs twice at once for one connection; every token write
 * is additionally fenced in the database (saveRefreshedTokens), so the lease is about not burning the grant and
 * the fence is what guarantees no stale overwrite.
 */

/**
 * Per-connection lease (Redis SET NX PX + token-checked release in prod, see createRedisConnectionLease). The
 * single BullMQ scheduler is not exclusive on its own: the next run is queued when a sweep starts, so a stalled
 * job whose lock is lost can overlap the next one. Jira rotates refresh tokens, so two concurrent refreshes of one
 * connection can burn the grant; the lease makes the refresh itself exclusive per connection.
 */
export interface ConnectionLease {
  /** Take the lease for `key` for `ttlMs`; resolves to an owner token, or null when someone else holds it. */
  acquire(key: string, ttlMs: number): Promise<string | null>;
  /**
   * True only if `token` still owns the lease; then its TTL is reset to `ttlMs` (atomic compare-and-PEXPIRE), so
   * the write that follows runs inside a fresh lease window. False when it expired (and maybe was re-taken).
   */
  confirm(key: string, token: string, ttlMs: number): Promise<boolean>;
  /** Release only if `token` still owns the lease (never deletes a lease that expired and was re-taken). */
  release(key: string, token: string): Promise<boolean>;
}

/**
 * Lease TTL. Everything held under it is bounded well below it: the provider refresh by
 * TOKEN_REFRESH_TIMEOUT_MS (request and body read), each lease Redis call by TOKEN_REFRESH_LEASE_OP_TIMEOUT_MS,
 * and the saves by the repository's transaction timeout. Before any write the lease is re-confirmed (which renews
 * it) and the write itself is fenced in the database, so even a holder that outlives the TTL cannot overwrite a
 * newer refresh. If a holder crashes, the lease expires on its own.
 */
export const TOKEN_REFRESH_LEASE_TTL_MS = 120_000;
/** Each lease Redis call (acquire / confirm / release) fails after this instead of hanging on a dead Redis. */
export const TOKEN_REFRESH_LEASE_OP_TIMEOUT_MS = 2_000;

/** Lease key for one connection (org-scoped so ids never collide across tenants). */
export function tokenRefreshLeaseKey(organizationId: string, integrationId: string): string {
  return `integrations:token-refresh:lease:${organizationId}:${integrationId}`;
}

/** A lease Redis call did not answer in time (Redis unreachable or stalled). */
export class LeaseTimeoutError extends Error {
  constructor() {
    super('integration token refresh lease call timed out');
    this.name = 'LeaseTimeoutError';
  }
}

/** Rejects with LeaseTimeoutError when `p` has not settled within `ms`. */
export async function boundedLeaseOp<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LeaseTimeoutError()), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Compare-and-delete: release the lease only while it still holds this owner's token (atomic in Redis). */
export const RELEASE_LEASE_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

/**
 * Compare-and-renew: while the lease still holds this owner's token, reset its TTL to ARGV[2] ms and return 1;
 * otherwise return 0 (it expired, and maybe someone else holds it now). Atomic in Redis.
 */
export const CONFIRM_LEASE_LUA = `if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0`;

/** Minimal ioredis surface the lease needs. */
export interface LeaseRedis {
  set(key: string, value: string, px: 'PX', ttlMs: number, nx: 'NX'): Promise<'OK' | null>;
  eval(script: string, numKeys: number, ...args: string[]): Promise<unknown>;
}

/**
 * Per-connection lease on Redis: `SET key <random token> PX ttl NX` takes it (atomic, auto-expiring), and release
 * runs RELEASE_LEASE_LUA so a holder whose lease expired can never delete the next holder's lease, and confirm
 * runs CONFIRM_LEASE_LUA (ownership check + renewal) right before the holder writes. Every call is bounded by
 * `opTimeoutMs` (LeaseTimeoutError), so an unreachable Redis fails fast instead of hanging the sweep.
 */
export function createRedisConnectionLease(
  redis: LeaseRedis,
  newToken: () => string = randomUUID,
  opTimeoutMs: number = TOKEN_REFRESH_LEASE_OP_TIMEOUT_MS,
): ConnectionLease {
  const bounded = <T>(p: Promise<T>): Promise<T> => boundedLeaseOp(p, opTimeoutMs);
  const checkTtl = (ttlMs: number) => {
    if (!Number.isInteger(ttlMs) || ttlMs <= 0)
      throw new RangeError('ttlMs must be a positive integer');
  };
  return {
    async acquire(key, ttlMs) {
      checkTtl(ttlMs);
      const token = newToken();
      return (await bounded(redis.set(key, token, 'PX', ttlMs, 'NX'))) === 'OK' ? token : null;
    },
    async confirm(key, token, ttlMs) {
      checkTtl(ttlMs);
      return (
        Number(await bounded(redis.eval(CONFIRM_LEASE_LUA, 1, key, token, String(ttlMs)))) === 1
      );
    },
    async release(key, token) {
      return Number(await bounded(redis.eval(RELEASE_LEASE_LUA, 1, key, token))) === 1;
    },
  };
}

/**
 * ioredis options for the lease connection: fail fast instead of queueing commands forever while Redis is down
 * (the queue default, maxRetriesPerRequest: null, is right for BullMQ but would hang every lease call).
 */
export const LEASE_REDIS_OPTIONS = {
  maxRetriesPerRequest: 1,
  commandTimeout: TOKEN_REFRESH_LEASE_OP_TIMEOUT_MS,
  connectTimeout: 5_000,
} as const;
