import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { verifyGitHubWebhook, verifyGitHubSignature, assertGitHubWebhook, InMemoryDeliveryStore, type WebhookSecretResolver } from '../src';

const secret = 'test-secret';
const body = JSON.stringify({ action: 'opened', issue: { number: 1 }, installation: { id: 4242 } });
const sign = (b: string, s = secret) => 'sha256=' + createHmac('sha256', s).update(b).digest('hex');
const headers = (over: Record<string, string | undefined> = {}) => ({ 'X-Hub-Signature-256': sign(body), 'X-GitHub-Delivery': 'd-1', 'X-GitHub-Event': 'issues', 'X-GitHub-Hook-ID': '77', ...over });
const store = () => new InMemoryDeliveryStore({ nodeEnv: 'test' });
const resolver = (result: Awaited<ReturnType<WebhookSecretResolver['resolve']>> = { organizationId: 'org_1', integrationId: 'int_1', secret }) => ({ resolve: vi.fn(async () => result) });

describe('verifyGitHubSignature', () => {
  it('accepts valid and rejects bad signatures; missing secret fails closed', () => {
    expect(verifyGitHubSignature(secret, body, sign(body))).toBeNull();
    expect(verifyGitHubSignature(secret, body + ' ', sign(body))).toBe('invalid_signature');
    expect(verifyGitHubSignature(secret, body, sign(body, 'other'))).toBe('invalid_signature');
    expect(verifyGitHubSignature(secret, body, undefined)).toBe('missing_signature');
    expect(verifyGitHubSignature(secret, body, 'sha1=abc')).toBe('malformed_signature');
    expect(verifyGitHubSignature('', body, sign(body))).toBe('invalid_signature');
    expect(verifyGitHubSignature(secret, Buffer.from(body), sign(body))).toBeNull();
  });
});

describe('verifyGitHubWebhook', () => {
  it('routes by hook/installation ids, returns tenant, blocks replays', async () => {
    const s = store();
    const r = resolver();
    const res = await verifyGitHubWebhook({ secretResolver: r, rawBody: body, headers: headers({ 'X-GitHub-Hook-Installation-Target-ID': '123', 'X-GitHub-Hook-Installation-Target-Type': 'repository' }), deliveryStore: s });
    expect(res).toMatchObject({ ok: true, deliveryId: 'd-1', event: 'issues', organizationId: 'org_1', integrationId: 'int_1' });
    expect(r.resolve).toHaveBeenCalledWith({ hookId: '77', targetId: '123', targetType: 'repository', installationId: '4242' });
    expect(await verifyGitHubWebhook({ secretResolver: r, rawBody: body, headers: headers(), deliveryStore: s })).toEqual({ ok: false, reason: 'replayed_delivery', status: 409 });
  });
  it('unknown integration or missing secret -> 401 (not 500)', async () => {
    expect(await verifyGitHubWebhook({ secretResolver: resolver(null), rawBody: body, headers: headers(), deliveryStore: store() })).toEqual({ ok: false, reason: 'unknown_integration', status: 401 });
    expect(await verifyGitHubWebhook({ secretResolver: resolver({ organizationId: 'o', integrationId: 'i', secret: '' }), rawBody: body, headers: headers(), deliveryStore: store() })).toMatchObject({ status: 401 });
    const noIds = JSON.stringify({ action: 'opened' });
    expect(await verifyGitHubWebhook({ secretResolver: resolver(), rawBody: noIds, headers: headers({ 'X-GitHub-Hook-ID': undefined, 'X-Hub-Signature-256': sign(noIds) }), deliveryStore: store() })).toMatchObject({ reason: 'unknown_integration', status: 401 });
  });
  it("another integration's secret does not verify", async () => {
    const res = await verifyGitHubWebhook({ secretResolver: resolver({ organizationId: 'org_2', integrationId: 'int_2', secret: 'other-secret' }), rawBody: body, headers: headers(), deliveryStore: store() });
    expect(res).toMatchObject({ ok: false, reason: 'invalid_signature', status: 401 });
  });
  it('does not record delivery ids for invalid signatures', async () => {
    const s = store();
    await verifyGitHubWebhook({ secretResolver: resolver(), rawBody: body, headers: headers({ 'X-Hub-Signature-256': sign(body, 'x') }), deliveryStore: s });
    expect(s.size).toBe(0);
  });
  it('requires delivery id, valid json and bounded size', async () => {
    expect(await verifyGitHubWebhook({ secretResolver: resolver(), rawBody: body, headers: headers({ 'X-GitHub-Delivery': undefined }), deliveryStore: store() })).toMatchObject({ reason: 'missing_delivery_id', status: 400 });
    expect(await verifyGitHubWebhook({ secretResolver: resolver(), rawBody: 'not-json', headers: headers({ 'X-Hub-Signature-256': sign('not-json') }), deliveryStore: store() })).toMatchObject({ reason: 'invalid_payload' });
    expect(await verifyGitHubWebhook({ secretResolver: resolver(), rawBody: body, headers: headers(), deliveryStore: store(), maxBodyBytes: 10 })).toMatchObject({ reason: 'payload_too_large', status: 413 });
  });
  it('supports Headers objects and the throwing variant', async () => {
    const h = new Headers(headers({ 'X-GitHub-Delivery': 'd-2' }));
    expect((await assertGitHubWebhook({ secretResolver: resolver(), rawBody: body, headers: h, deliveryStore: store() })).deliveryId).toBe('d-2');
    await expect(assertGitHubWebhook({ secretResolver: resolver(), rawBody: body, headers: {}, deliveryStore: store() })).rejects.toMatchObject({ name: 'WebhookVerificationError', reason: 'missing_signature' });
  });
});

describe('InMemoryDeliveryStore', () => {
  it('expires entries after TTL and caps size', async () => {
    let now = 0;
    const s = new InMemoryDeliveryStore({ now: () => now, nodeEnv: 'test' });
    expect(await s.markIfNew('a', 10)).toBe(true);
    expect(await s.markIfNew('a', 10)).toBe(false);
    now = 10_001;
    expect(await s.markIfNew('a', 10)).toBe(true);
    const capped = new InMemoryDeliveryStore({ maxEntries: 2, nodeEnv: 'test' });
    for (const id of ['a', 'b', 'c']) await capped.markIfNew(id, 60);
    expect(capped.size).toBe(2);
  });
  it('refuses production unless explicitly allowed', () => {
    expect(() => new InMemoryDeliveryStore({ nodeEnv: 'production' })).toThrow(/not allowed in production/);
    expect(() => new InMemoryDeliveryStore({ nodeEnv: 'production', unsafeAllowInProduction: true })).not.toThrow();
  });
});
