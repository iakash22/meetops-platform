import { randomUUID } from 'node:crypto';
import { effectiveReplayTtlSeconds, type DeliveryStore } from './webhook.js';

/** Minimal ioredis surface: `SET key value EX ttl NX`, `EXISTS`, and `EVAL` for holder-checked commit/release. */
export interface RedisSetNxClient {
  set(key: string, value: string, ex: 'EX', ttl: number, nx: 'NX'): Promise<'OK' | null>;
  /** Read-only replay check. */
  exists(key: string): Promise<number>;
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
}

const PENDING = 'pending:';
// Only the claim holder may promote or delete its marker.
const COMMIT_LUA =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('SET', KEYS[1], '1', 'EX', ARGV[2]) return 1 end return 0";
const RELEASE_LUA =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0";

export interface RedisDeliveryStoreOptions {
  /** Default "meetops:webhook:delivery:". */
  keyPrefix?: string;
  /** Used when markIfNew is called with a non-positive TTL. Default and minimum 604800s (7 days). */
  defaultTtlSeconds?: number;
}

/**
 * Replay-protection store backed by Redis; atomic via SET NX EX. Safe across replicas.
 * Production must wire this store: InMemoryDeliveryStore is per-process and refuses NODE_ENV=production.
 */
export class RedisDeliveryStore implements DeliveryStore {
  private readonly prefix: string;
  private readonly defaultTtl: number;

  constructor(
    private readonly redis: RedisSetNxClient,
    options: RedisDeliveryStoreOptions = {},
  ) {
    this.prefix = options.keyPrefix ?? 'meetops:webhook:delivery:';
    this.defaultTtl = effectiveReplayTtlSeconds(options.defaultTtlSeconds);
  }

  async isRecorded(deliveryId: string): Promise<boolean> {
    if (!deliveryId) throw new Error('deliveryId is required');
    return (await this.redis.exists(this.prefix + deliveryId)) > 0;
  }

  async claim(deliveryId: string, pendingTtlSeconds: number): Promise<string | null> {
    if (!deliveryId) throw new Error('deliveryId is required');
    const token = PENDING + randomUUID();
    const ttl = Math.max(1, Math.floor(pendingTtlSeconds));
    return (await this.redis.set(this.prefix + deliveryId, token, 'EX', ttl, 'NX')) === 'OK'
      ? token
      : null;
  }

  async commit(deliveryId: string, token: string, ttlSeconds: number): Promise<boolean> {
    const ttl =
      Number.isFinite(ttlSeconds) && ttlSeconds > 0
        ? effectiveReplayTtlSeconds(ttlSeconds)
        : this.defaultTtl;
    return Number(await this.redis.eval(COMMIT_LUA, 1, this.prefix + deliveryId, token, ttl)) === 1;
  }

  async release(deliveryId: string, token: string): Promise<void> {
    await this.redis.eval(RELEASE_LUA, 1, this.prefix + deliveryId, token);
  }

  async markIfNew(deliveryId: string, ttlSeconds: number): Promise<boolean> {
    if (!deliveryId) throw new Error('deliveryId is required');
    const ttl =
      Number.isFinite(ttlSeconds) && ttlSeconds > 0
        ? effectiveReplayTtlSeconds(ttlSeconds)
        : this.defaultTtl;
    const res = await this.redis.set(this.prefix + deliveryId, '1', 'EX', ttl, 'NX');
    return res === 'OK';
  }
}
