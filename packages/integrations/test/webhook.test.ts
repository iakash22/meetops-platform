import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { checkJiraWebhookFreshness, checkTimestampFreshness, effectiveReplayTtlSeconds, isValidGitHubDeliveryId, MIN_REPLAY_TTL_SECONDS, verifyGitHubWebhook, verifyGitHubSignature, assertGitHubWebhook, InMemoryDeliveryStore, type WebhookSecretResolver } from '../src';

const secret = 'test-secret';
const body = JSON.stringify({ action: 'opened', issue: { number: 1 }, installation: { id: 4242 } });
const sign = (b: string, s = secret) => 'sha256=' + createHmac('sha256', s).update(b).digest('hex');
const headers = (over: Record<string, string | undefined> = {}) => ({ 'X-Hub-Signature-256': sign(body), 'X-GitHub-Delivery': '72d3162e-cc78-11e3-81ab-4c9367dc0958', 'X-GitHub-Event': 'issues', 'X-GitHub-Hook-ID': '77', ...over });
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
    expect(res).toMatchObject({ ok: true, deliveryId: '72d3162e-cc78-11e3-81ab-4c9367dc0958', event: 'issues', organizationId: 'org_1', integrationId: 'int_1' });
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
    const h = new Headers(headers({ 'X-GitHub-Delivery': '11111111-2222-4333-8444-555555555555' }));
    expect((await assertGitHubWebhook({ secretResolver: resolver(), rawBody: body, headers: h, deliveryStore: store() })).deliveryId).toBe('11111111-2222-4333-8444-555555555555');
    await expect(assertGitHubWebhook({ secretResolver: resolver(), rawBody: body, headers: {}, deliveryStore: store() })).rejects.toMatchObject({ name: 'WebhookVerificationError', reason: 'missing_signature' });
  });
});

describe('InMemoryDeliveryStore', () => {
  it('expires entries after TTL and caps size', async () => {
    let now = 0;
    const s = new InMemoryDeliveryStore({ now: () => now, nodeEnv: 'test' });
    expect(await s.markIfNew('a', 10)).toBe(true);
    expect(await s.markIfNew('a', 10)).toBe(false);
    now = 10_001; // a 10s request is raised to the 7-day minimum
    expect(await s.markIfNew('a', 10)).toBe(false);
    now = 604_800_001;
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

describe('replay TTL', () => {
  it('defaults to and enforces a 7-day minimum', () => {
    expect(MIN_REPLAY_TTL_SECONDS).toBe(604_800);
    expect(effectiveReplayTtlSeconds()).toBe(604_800);
    expect(effectiveReplayTtlSeconds(60)).toBe(604_800);
    expect(effectiveReplayTtlSeconds(Number.NaN)).toBe(604_800);
    expect(effectiveReplayTtlSeconds(1_000_000.2)).toBe(1_000_001);
  });
  it('passes the clamped TTL to the store', async () => {
    const markIfNew = vi.fn(async () => true);
    await verifyGitHubWebhook({ secretResolver: resolver(), rawBody: body, headers: headers(), deliveryStore: { markIfNew }, replayTtlSeconds: 30 });
    expect(markIfNew).toHaveBeenCalledWith('72d3162e-cc78-11e3-81ab-4c9367dc0958', 604_800);
  });
});

describe('delivery id format', () => {
  it('accepts GUIDs only, bounded length', () => {
    expect(isValidGitHubDeliveryId('72d3162e-cc78-11e3-81ab-4c9367dc0958')).toBe(true);
    expect(isValidGitHubDeliveryId('72D3162E-CC78-11E3-81AB-4C9367DC0958')).toBe(true);
    for (const bad of ['d-1', '', '72d3162e-cc78-11e3-81ab-4c9367dc0958x', 'x'.repeat(65), '72d3162e-cc78-11e3-81ab-4c9367dc0958\n', '../../etc', undefined]) expect(isValidGitHubDeliveryId(bad)).toBe(false);
  });
  it('rejects malformed ids with 400 before the store is touched', async () => {
    const markIfNew = vi.fn(async () => true);
    for (const id of ['d-1', 'a'.repeat(500), 'key:*']) {
      expect(await verifyGitHubWebhook({ secretResolver: resolver(), rawBody: body, headers: headers({ 'X-GitHub-Delivery': id }), deliveryStore: { markIfNew } })).toMatchObject({ ok: false, reason: 'malformed_delivery_id', status: 400 });
    }
    expect(markIfNew).not.toHaveBeenCalled();
  });
  it('normalizes case so upper/lower variants are the same delivery', async () => {
    const s = store();
    expect((await verifyGitHubWebhook({ secretResolver: resolver(), rawBody: body, headers: headers({ 'X-GitHub-Delivery': '72D3162E-CC78-11E3-81AB-4C9367DC0958' }), deliveryStore: s })).ok).toBe(true);
    expect(await verifyGitHubWebhook({ secretResolver: resolver(), rawBody: body, headers: headers(), deliveryStore: s })).toMatchObject({ reason: 'replayed_delivery' });
  });
});

describe('timestamp freshness', () => {
  const now = () => Date.parse('2026-10-22T00:00:00Z');
  it('classifies ms, s and ISO timestamps', () => {
    const t = now();
    expect(checkTimestampFreshness(t - 1000, { maxAgeSeconds: 300, now })).toBe('fresh');
    expect(checkTimestampFreshness(Math.floor(t / 1000) - 10, { maxAgeSeconds: 300, now })).toBe('fresh');
    expect(checkTimestampFreshness(String(t), { maxAgeSeconds: 300, now })).toBe('fresh');
    expect(checkTimestampFreshness('2026-10-21T23:59:00Z', { maxAgeSeconds: 300, now })).toBe('fresh');
    expect(checkTimestampFreshness(t - 301_000, { maxAgeSeconds: 300, now })).toBe('stale');
    expect(checkTimestampFreshness(t + 301_000, { maxAgeSeconds: 300, now })).toBe('future');
    expect(checkTimestampFreshness(t + 10_000, { maxAgeSeconds: 300, maxFutureSkewSeconds: 5, now })).toBe('future');
    for (const bad of ['nope', null, {}, Number.NaN]) expect(checkTimestampFreshness(bad, { maxAgeSeconds: 300, now })).toBe('invalid');
    expect(checkTimestampFreshness(t, { maxAgeSeconds: 0, now })).toBe('invalid');
  });
  it('reads the Jira payload timestamp field', () => {
    expect(checkJiraWebhookFreshness({ timestamp: now() - 5000, webhookEvent: 'jira:issue_updated' }, { maxAgeSeconds: 300, now })).toBe('fresh');
    expect(checkJiraWebhookFreshness({ timestamp: now() - 3_600_000 }, { maxAgeSeconds: 300, now })).toBe('stale');
    expect(checkJiraWebhookFreshness({}, { maxAgeSeconds: 300, now })).toBe('absent');
    expect(checkJiraWebhookFreshness({}, { maxAgeSeconds: 300, now, requireTimestamp: true })).toBe('invalid');
  });
});
