import { Redis, type RedisOptions } from 'ioredis';
import { redisTlsOptions } from '@meetops/config';

/** ioredis connection for REDIS_URL. rediss:// also sets the TLS server name Layerbase requires. */
export function createAppRedis(url: string, options: RedisOptions = {}): Redis {
  return new Redis(url, { ...options, ...redisTlsOptions(url) });
}
