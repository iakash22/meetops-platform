import type { DeliveryStore } from './webhook.js';

/** Minimal ioredis surface (`SET key value EX ttl NX`). */
export interface RedisSetNxClient {
  set(key: string, value: string, ex: 'EX', ttl: number, nx: 'NX'): Promise<'OK' | null>;
}

export interface RedisDeliveryStoreOptions {
  /** Default "meetops:webhook:delivery:". */
  keyPrefix?: string;
  /** Used when markIfNew is called with a non-positive TTL. Default 86400s. */
  defaultTtlSeconds?: number;
}

/** Replay-protection store backed by Redis; atomic via SET NX EX. Safe across replicas. */
export class RedisDeliveryStore implements DeliveryStore {
  private readonly prefix: string;
  private readonly defaultTtl: number;

  constructor(
    private readonly redis: RedisSetNxClient,
    options: RedisDeliveryStoreOptions = {}
  ) {
    this.prefix = options.keyPrefix ?? 'meetops:webhook:delivery:';
    this.defaultTtl = options.defaultTtlSeconds ?? 86_400;
  }

  async markIfNew(deliveryId: string, ttlSeconds: number): Promise<boolean> {
    if (!deliveryId) throw new Error('deliveryId is required');
    const ttl = Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? Math.ceil(ttlSeconds) : this.defaultTtl;
    const res = await this.redis.set(this.prefix + deliveryId, '1', 'EX', ttl, 'NX');
    return res === 'OK';
  }
}
