import { describe, it, expect } from 'vitest';
import { createRedisClient } from '@meetops/queue';

describe('worker bootstrap helpers', () => {
  it('can construct a lazy Redis client', async () => {
    const client = createRedisClient();
    expect(client.status).toBe('wait'); // ioredis starts in 'wait' before connect()
    client.disconnect();
  });
});
