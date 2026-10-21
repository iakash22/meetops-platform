import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyGitHubWebhook, verifyGitHubSignature, assertGitHubWebhook, InMemoryDeliveryStore } from '../src';

const secret = 'test-secret';
const body = JSON.stringify({ action: 'opened', issue: { number: 1 } });
const sign = (b: string, s = secret) => 'sha256=' + createHmac('sha256', s).update(b).digest('hex');
const headers = (over: Record<string, string | undefined> = {}) => ({ 'X-Hub-Signature-256': sign(body), 'X-GitHub-Delivery': 'd-1', 'X-GitHub-Event': 'issues', ...over });

describe('verifyGitHubSignature', () => {
  it('accepts valid and rejects bad signatures', () => {
    expect(verifyGitHubSignature(secret, body, sign(body))).toBeNull();
    expect(verifyGitHubSignature(secret, body + ' ', sign(body))).toBe('invalid_signature');
    expect(verifyGitHubSignature(secret, body, sign(body, 'other'))).toBe('invalid_signature');
    expect(verifyGitHubSignature(secret, body, undefined)).toBe('missing_signature');
    expect(verifyGitHubSignature(secret, body, 'sha1=abc')).toBe('malformed_signature');
    expect(verifyGitHubSignature(secret, body, 'sha256=abcd')).toBe('malformed_signature');
    expect(verifyGitHubSignature('', body, sign(body))).toBe('missing_secret');
  });
  it('works with Uint8Array bodies', () => {
    expect(verifyGitHubSignature(secret, Buffer.from(body), sign(body))).toBeNull();
  });
});

describe('verifyGitHubWebhook', () => {
  it('returns payload for a valid delivery and blocks replays', async () => {
    const store = new InMemoryDeliveryStore();
    const r = await verifyGitHubWebhook({ secret, rawBody: body, headers: headers(), deliveryStore: store });
    expect(r).toMatchObject({ ok: true, deliveryId: 'd-1', event: 'issues', payload: { action: 'opened' } });
    const again = await verifyGitHubWebhook({ secret, rawBody: body, headers: headers(), deliveryStore: store });
    expect(again).toEqual({ ok: false, reason: 'replayed_delivery', status: 409 });
  });
  it('does not record delivery ids for invalid signatures', async () => {
    const store = new InMemoryDeliveryStore();
    const bad = await verifyGitHubWebhook({ secret, rawBody: body, headers: headers({ 'X-Hub-Signature-256': sign(body, 'x') }), deliveryStore: store });
    expect(bad).toMatchObject({ ok: false, reason: 'invalid_signature', status: 401 });
    expect(store.size).toBe(0);
  });
  it('requires delivery id and valid json', async () => {
    const store = new InMemoryDeliveryStore();
    expect(await verifyGitHubWebhook({ secret, rawBody: body, headers: headers({ 'X-GitHub-Delivery': undefined }), deliveryStore: store })).toMatchObject({ reason: 'missing_delivery_id' });
    expect(await verifyGitHubWebhook({ secret, rawBody: 'not-json', headers: headers({ 'X-Hub-Signature-256': sign('not-json') }), deliveryStore: store })).toMatchObject({ reason: 'invalid_payload' });
  });
  it('supports Headers objects and the throwing variant', async () => {
    const h = new Headers(headers({ 'X-GitHub-Delivery': 'd-2' }));
    expect((await assertGitHubWebhook({ secret, rawBody: body, headers: h, deliveryStore: new InMemoryDeliveryStore() })).deliveryId).toBe('d-2');
    await expect(assertGitHubWebhook({ secret, rawBody: body, headers: {}, deliveryStore: new InMemoryDeliveryStore() })).rejects.toMatchObject({ name: 'WebhookVerificationError', reason: 'missing_signature' });
  });
});

describe('InMemoryDeliveryStore', () => {
  it('expires entries after TTL', async () => {
    let now = 0;
    const store = new InMemoryDeliveryStore(() => now);
    expect(await store.markIfNew('a', 10)).toBe(true);
    expect(await store.markIfNew('a', 10)).toBe(false);
    now = 10_001;
    expect(await store.markIfNew('a', 10)).toBe(true);
  });
  it('caps entries', async () => {
    const store = new InMemoryDeliveryStore(Date.now, 2);
    for (const id of ['a', 'b', 'c']) await store.markIfNew(id, 60);
    expect(store.size).toBe(2);
  });
});
