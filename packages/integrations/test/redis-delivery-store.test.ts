import { describe, it, expect, vi } from 'vitest';
import RedisMock from 'ioredis-mock';
import { createHmac } from 'node:crypto';
import { RedisDeliveryStore, verifyGitHubWebhook } from '../src';

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
    const store = new RedisDeliveryStore({ set }, { defaultTtlSeconds: 123 });
    await store.markIfNew('x', 0);
    expect(set).toHaveBeenCalledWith('meetops:webhook:delivery:x', '1', 'EX', 604_800, 'NX');
    await new RedisDeliveryStore({ set }, { defaultTtlSeconds: 1_209_600 }).markIfNew('y', -1);
    expect(set).toHaveBeenLastCalledWith('meetops:webhook:delivery:y', '1', 'EX', 1_209_600, 'NX');
    await store.markIfNew('z', 900_000);
    expect(set).toHaveBeenLastCalledWith('meetops:webhook:delivery:z', '1', 'EX', 900_000, 'NX');
    await expect(store.markIfNew('', 10)).rejects.toThrow();
  });
  it('plugs into verifyGitHubWebhook replay protection', async () => {
    const store = new RedisDeliveryStore(new RedisMock());
    const body = '{"a":1}';
    const headers = { 'x-hub-signature-256': 'sha256=' + createHmac('sha256', 's').update(body).digest('hex'), 'x-github-delivery': '72d3162e-cc78-11e3-81ab-4c9367dc0958', 'x-github-hook-id': '1' };
    const secretResolver = { resolve: async () => ({ organizationId: 'org_1', integrationId: 'int_1', secret: 's' }) };
    expect((await verifyGitHubWebhook({ secretResolver, rawBody: body, headers, deliveryStore: store })).ok).toBe(true);
    expect(await verifyGitHubWebhook({ secretResolver, rawBody: body, headers, deliveryStore: store })).toMatchObject({ reason: 'replayed_delivery' });
  });
});
