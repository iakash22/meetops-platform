import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { Redis } from 'ioredis';
import { REDIS_CLIENT_OPTIONS, REDIS_COMMAND_TIMEOUT_MS } from '../src/modules/index.js';
import { RedisRateLimiter } from '../src/modules/auth/infrastructure/rate-limit/redis.js';
import type { RateLimiter } from '../src/modules/auth/domain/ports.js';
import {
  MEDIA_RATE_LIMITS,
  mediaRateLimit,
  RateLimiterUnavailableError,
} from '../src/modules/media/http/rate-limit.js';
import type { DirectoryCaller } from '../src/modules/directory/access.js';

const caller = {
  ctx: { organizationId: 'org-1', userId: 'user-1' },
  meta: { ip: '10.0.0.1' },
} as unknown as DirectoryCaller;

/** A "Redis" that accepts TCP connections and reads everything but never writes a byte back. */
async function silentRedis() {
  const sockets: Socket[] = [];
  const server: Server = createServer((s) => {
    sockets.push(s);
    s.on('data', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  return {
    url: `redis://127.0.0.1:${port}`,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

describe('media rate limiter: Redis accepts the connection but never answers', () => {
  const cleanups: (() => Promise<unknown> | void)[] = [];
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c();
  });

  it('the API ioredis client sets a ~1 s commandTimeout', () => {
    expect(REDIS_CLIENT_OPTIONS.commandTimeout).toBe(REDIS_COMMAND_TIMEOUT_MS);
    expect(REDIS_COMMAND_TIMEOUT_MS).toBe(1_000);
  });

  it('a silent Redis fails closed with RateLimiterUnavailableError (503, Retry-After 5) instead of hanging', async () => {
    const srv = await silentRedis();
    cleanups.push(srv.close);
    const client = new Redis(srv.url, { ...REDIS_CLIENT_OPTIONS, retryStrategy: () => null });
    client.on('error', () => undefined);
    cleanups.push(() => client.disconnect());
    const rl = mediaRateLimit(new RedisRateLimiter(client), MEDIA_RATE_LIMITS);
    const t0 = Date.now();
    const err = await rl.control(caller).then(
      () => undefined,
      (e: unknown) => e,
    );
    const elapsed = Date.now() - t0;
    expect(err).toBeInstanceOf(RateLimiterUnavailableError);
    expect((err as RateLimiterUnavailableError).statusCode).toBe(503);
    expect((err as RateLimiterUnavailableError).retryAfterMs).toBe(5_000);
    expect(elapsed).toBeLessThan(3_000);
  });

  it('a limiter call that never settles hits the consume backstop timeout and fails closed', async () => {
    const hanging: RateLimiter = { consume: () => new Promise(() => undefined) };
    const rl = mediaRateLimit(hanging, MEDIA_RATE_LIMITS, 50);
    await expect(rl.chunkUser(caller)).rejects.toBeInstanceOf(RateLimiterUnavailableError);
  });
});
