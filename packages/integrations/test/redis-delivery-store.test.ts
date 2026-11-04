import { describe, it, expect, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import { createHmac } from 'node:crypto';
import { RedisDeliveryStore, recordDelivery, verifyGitHubWebhook } from '../src';

describe('RedisDeliveryStore', () => {
  it('records first delivery and rejects duplicates (ioredis-mock)', async () => {
    const redis = new RedisMock();
    const store = new RedisDeliveryStore(redis, { keyPrefix: 't:' });
    expect(await store.markIfNew('abc', 60)).toBe(true);
    expect(await store.markIfNew('abc', 60)).toBe(false);
    expect(await store.markIfNew('def', 60)).toBe(true);
    const ttl = await redis.ttl('t:abc');
    expect(ttl).toBeGreaterThan(604_000); // 60s request raised to the 7-day minimum
    expect(ttl).toBeLessThanOrEqual(604_800);
  });
  it('sends SET NX EX with prefix and default TTL', async () => {
    const set = vi.fn().mockResolvedValue('OK');
    const store = new RedisDeliveryStore(
      { set, exists: vi.fn(), eval: vi.fn() },
      { defaultTtlSeconds: 123 },
    );
    await store.markIfNew('x', 0);
    expect(set).toHaveBeenCalledWith('meetops:webhook:delivery:x', '1', 'EX', 604_800, 'NX');
    await new RedisDeliveryStore(
      { set, exists: vi.fn(), eval: vi.fn() },
      { defaultTtlSeconds: 1_209_600 },
    ).markIfNew('y', -1);
    expect(set).toHaveBeenLastCalledWith('meetops:webhook:delivery:y', '1', 'EX', 1_209_600, 'NX');
    await store.markIfNew('z', 900_000);
    expect(set).toHaveBeenLastCalledWith('meetops:webhook:delivery:z', '1', 'EX', 900_000, 'NX');
    await expect(store.markIfNew('', 10)).rejects.toThrow();
  });
  it('plugs into verifyGitHubWebhook replay protection', async () => {
    const store = new RedisDeliveryStore(new RedisMock());
    const body = '{"a":1}';
    const headers = {
      'x-hub-signature-256': 'sha256=' + createHmac('sha256', 's').update(body).digest('hex'),
      'x-github-delivery': '72d3162e-cc78-11e3-81ab-4c9367dc0958',
      'x-github-hook-id': '1',
    };
    const secretResolver = {
      resolve: async () => ({ organizationId: 'org_1', integrationId: 'int_1', secret: 's' }),
    };
    expect(
      (await verifyGitHubWebhook({ secretResolver, rawBody: body, headers, deliveryStore: store }))
        .ok,
    ).toBe(true);
    expect(
      await verifyGitHubWebhook({ secretResolver, rawBody: body, headers, deliveryStore: store }),
    ).toMatchObject({ reason: 'replayed_delivery' });
  });
  it('claim -> commit gives the full TTL; a second claim or a replay is refused', async () => {
    const redis = new RedisMock();
    const store = new RedisDeliveryStore(redis, { keyPrefix: 'c:' });
    const t = await store.claim('a', 30);
    expect(t).toMatch(/^pending:/);
    expect(await store.claim('a', 30)).toBeNull();
    expect(await redis.ttl('c:a')).toBeLessThanOrEqual(30);
    expect(await store.commit('a', t, 60)).toBe(true);
    expect(await redis.get('c:a')).toBe('1');
    expect(await redis.ttl('c:a')).toBeGreaterThan(604_000);
    expect(await store.claim('a', 30)).toBeNull();
  });
  it('only the holder may release or commit the pending marker', async () => {
    const redis = new RedisMock();
    const store = new RedisDeliveryStore(redis, { keyPrefix: 'h:' });
    const t = await store.claim('b', 30);
    await store.release('b', 'pending:someone-else');
    expect(await store.commit('b', 'pending:someone-else', 60)).toBe(false);
    expect(await redis.get('h:b')).toBe(t);
    await store.release('b', t);
    expect(await redis.exists('h:b')).toBe(0);
  });
  it('simultaneous duplicates charge the bucket once; a 429 releases the claim for the retry', async () => {
    const store = new RedisDeliveryStore(new RedisMock(), { keyPrefix: 'r:' });
    let charged = 0;
    const charge = async () => {
      charged++;
      await new Promise((r) => setTimeout(r, 5));
    };
    const results = await Promise.all([
      recordDelivery(store, 'd', 60, charge),
      recordDelivery(store, 'd', 60, charge),
      recordDelivery(store, 'd', 60, charge),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(charged).toBe(1);
    const limited = async () => {
      throw new Error('429');
    };
    await expect(recordDelivery(store, 'e', 60, limited)).rejects.toThrow('429');
    expect(await store.isRecorded('e')).toBe(false);
    expect(await recordDelivery(store, 'e', 60, async () => {})).toBe(true);
    expect(await recordDelivery(store, 'e', 60, async () => {})).toBe(false);
  });
});
