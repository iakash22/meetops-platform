import { effectiveReplayTtlSeconds, type DeliveryStore } from './webhook.js';

/** Minimal ioredis surface (`SET key value EX ttl NX`). */
export interface RedisSetNxClient {
  set(key: string, value: string, ex: 'EX', ttl: number, nx: 'NX'): Promise<'OK' | null>;
  /** Optional: enables the read-only replay check (EXISTS). */
  exists?(key: string): Promise<number>;
}

export interface RedisDeliveryStoreOptions {
  /** Default "meetops:webhook:delivery:". */
  keyPrefix?: string;
  /** Used when markIfNew is called with a non-positive TTL. Default and minimum 604800s (7 days). */
  defaultTtlSeconds?: number;
}

/** Replay-protection store backed by Redis; atomic via SET NX EX. Safe across replicas. */
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
    if (!this.redis.exists) return false;
    return (await this.redis.exists(this.prefix + deliveryId)) > 0;
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
