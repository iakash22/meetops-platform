import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import { RedisDeliveryStore, verifyJiraWebhook } from '../src';
import { createHmac } from 'node:crypto';

/** Real Redis (redis:7). Skipped unless REDIS_IT_URL is set, e.g. redis://127.0.0.1:6379/15. */
const URL = process.env.REDIS_IT_URL;

describe.skipIf(!URL)('RedisDeliveryStore against real Redis (REDIS_IT_URL)', () => {
  const redis = URL ? new Redis(URL, { lazyConnect: false, maxRetriesPerRequest: 1 }) : undefined;
  afterAll(async () => redis?.quit());
  const store = () => new RedisDeliveryStore(redis!, { keyPrefix: `it:${randomUUID()}:` });
  const secret = 'jira-secret';
  const body = '{"webhookEvent":"jira:issue_updated"}';
  const headers = (id: string) => ({
    'x-atlassian-webhook-identifier': id,
    'x-hub-signature': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
  });
  const verify = (s: RedisDeliveryStore, id: string, beforeRecord?: () => Promise<void>) =>
    verifyJiraWebhook({
      secret,
      integrationId: 'int-1',
      rawBody: body,
      headers: headers(id),
      deliveryStore: s,
      ...(beforeRecord ? { beforeRecord } : {}),
    });

  it('three-state reads on the shared key', async () => {
    const s = store();
    expect(await s.state('a')).toBe('absent');
    const t = await s.claim('a', 30);
    expect(t).toMatch(/^pending:/);
    expect(await s.state('a')).toBe('pending');
    expect(await s.commit('a', t as string, 60)).toBe(true);
    expect(await s.state('a')).toBe('recorded');
    expect(await redis!.ttl(`${(s as unknown as { prefix: string }).prefix}a`)).toBeGreaterThan(
      604_000,
    );
  });

  it('a pending duplicate is delivery_in_progress; a recorded one is replayed_delivery', async () => {
    const s = store();
    const id = randomUUID();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const first = verify(s, id, () => gate); // holds the pending claim
    await new Promise((r) => setTimeout(r, 20));
    expect(await verify(s, id)).toMatchObject({
      ok: false,
      reason: 'delivery_in_progress',
      status: 409,
    });
    release();
    expect(await first).toMatchObject({ ok: true });
    expect(await verify(s, id)).toMatchObject({
      ok: false,
      reason: 'replayed_delivery',
      status: 409,
    });
  });

  it('a 429 in beforeRecord releases the claim so the retry is processed once', async () => {
    const s = store();
    const id = randomUUID();
    await expect(
      verify(s, id, async () => {
        throw new Error('429');
      }),
    ).rejects.toThrow('429');
    expect(await verify(s, id)).toMatchObject({ ok: true });
    expect(await verify(s, id)).toMatchObject({ reason: 'replayed_delivery' });
  });
});
