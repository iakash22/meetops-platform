import { describe, it, expect, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  checkJiraWebhookFreshness,
  checkTimestampFreshness,
  effectiveReplayTtlSeconds,
  isValidGitHubDeliveryId,
  MIN_REPLAY_TTL_SECONDS,
  verifyGitHubWebhook,
  verifyGitHubSignature,
  assertGitHubWebhook,
  InMemoryDeliveryStore,
  type WebhookSecretResolver,
} from '../src';

const secret = 'test-secret';
const body = JSON.stringify({ action: 'opened', issue: { number: 1 }, installation: { id: 4242 } });
const sign = (b: string, s = secret) => 'sha256=' + createHmac('sha256', s).update(b).digest('hex');
const headers = (over: Record<string, string | undefined> = {}) => ({
  'X-Hub-Signature-256': sign(body),
  'X-GitHub-Delivery': '72d3162e-cc78-11e3-81ab-4c9367dc0958',
  'X-GitHub-Event': 'issues',
  'X-GitHub-Hook-ID': '77',
  ...over,
});
const store = () => new InMemoryDeliveryStore({ nodeEnv: 'test' });
const resolver = (
  result: Awaited<ReturnType<WebhookSecretResolver['resolve']>> = {
    organizationId: 'org_1',
    integrationId: 'int_1',
    secret,
  },
) => ({ resolve: vi.fn(async () => result) });

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
    const res = await verifyGitHubWebhook({
      secretResolver: r,
      rawBody: body,
      headers: headers({
        'X-GitHub-Hook-Installation-Target-ID': '123',
        'X-GitHub-Hook-Installation-Target-Type': 'repository',
      }),
      deliveryStore: s,
    });
    expect(res).toMatchObject({
      ok: true,
      deliveryId: '72d3162e-cc78-11e3-81ab-4c9367dc0958',
      event: 'issues',
      organizationId: 'org_1',
      integrationId: 'int_1',
    });
    expect(r.resolve).toHaveBeenCalledWith({
      hookId: '77',
      targetId: '123',
      targetType: 'repository',
      installationId: '4242',
    });
    expect(
      await verifyGitHubWebhook({
        secretResolver: r,
        rawBody: body,
        headers: headers(),
        deliveryStore: s,
      }),
    ).toEqual({ ok: false, reason: 'replayed_delivery', status: 409 });
  });
  it('unknown integration or missing secret -> 401 (not 500)', async () => {
    expect(
      await verifyGitHubWebhook({
        secretResolver: resolver(null),
        rawBody: body,
        headers: headers(),
        deliveryStore: store(),
      }),
    ).toEqual({ ok: false, reason: 'unknown_integration', status: 401 });
    expect(
      await verifyGitHubWebhook({
        secretResolver: resolver({ organizationId: 'o', integrationId: 'i', secret: '' }),
        rawBody: body,
        headers: headers(),
        deliveryStore: store(),
      }),
    ).toMatchObject({ status: 401 });
    const noIds = JSON.stringify({ action: 'opened' });
    expect(
      await verifyGitHubWebhook({
        secretResolver: resolver(),
        rawBody: noIds,
        headers: headers({ 'X-GitHub-Hook-ID': undefined, 'X-Hub-Signature-256': sign(noIds) }),
        deliveryStore: store(),
      }),
    ).toMatchObject({ reason: 'unknown_integration', status: 401 });
  });
  it("another integration's secret does not verify", async () => {
    const res = await verifyGitHubWebhook({
      secretResolver: resolver({
        organizationId: 'org_2',
        integrationId: 'int_2',
        secret: 'other-secret',
      }),
      rawBody: body,
      headers: headers(),
      deliveryStore: store(),
    });
    expect(res).toMatchObject({ ok: false, reason: 'invalid_signature', status: 401 });
  });
  it('does not record delivery ids for invalid signatures', async () => {
    const s = store();
    await verifyGitHubWebhook({
      secretResolver: resolver(),
      rawBody: body,
      headers: headers({ 'X-Hub-Signature-256': sign(body, 'x') }),
      deliveryStore: s,
    });
    expect(s.size).toBe(0);
  });
  it('requires delivery id, valid json and bounded size', async () => {
    expect(
      await verifyGitHubWebhook({
        secretResolver: resolver(),
        rawBody: body,
        headers: headers({ 'X-GitHub-Delivery': undefined }),
        deliveryStore: store(),
      }),
    ).toMatchObject({ reason: 'missing_delivery_id', status: 400 });
    expect(
      await verifyGitHubWebhook({
        secretResolver: resolver(),
        rawBody: 'not-json',
        headers: headers({ 'X-Hub-Signature-256': sign('not-json') }),
        deliveryStore: store(),
      }),
    ).toMatchObject({ reason: 'invalid_payload' });
    expect(
      await verifyGitHubWebhook({
        secretResolver: resolver(),
        rawBody: body,
        headers: headers(),
        deliveryStore: store(),
        maxBodyBytes: 10,
      }),
    ).toMatchObject({ reason: 'payload_too_large', status: 413 });
  });
  it('supports Headers objects and the throwing variant', async () => {
    const h = new Headers(headers({ 'X-GitHub-Delivery': '11111111-2222-4333-8444-555555555555' }));
    expect(
      (
        await assertGitHubWebhook({
          secretResolver: resolver(),
          rawBody: body,
          headers: h,
          deliveryStore: store(),
        })
      ).deliveryId,
    ).toBe('11111111-2222-4333-8444-555555555555');
    await expect(
      assertGitHubWebhook({
        secretResolver: resolver(),
        rawBody: body,
        headers: {},
        deliveryStore: store(),
      }),
    ).rejects.toMatchObject({ name: 'WebhookVerificationError', reason: 'missing_signature' });
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
  it('refuses production (no escape hatch)', () => {
    expect(() => new InMemoryDeliveryStore({ nodeEnv: 'production' })).toThrow(
      /not allowed outside development\/test/,
    );
  });
  it('state: absent -> pending -> recorded', async () => {
    const s = new InMemoryDeliveryStore({ nodeEnv: 'test' });
    expect(await s.state('z')).toBe('absent');
    const t = await s.claim('z', 30);
    expect(await s.state('z')).toBe('pending');
    expect(await s.isRecorded('z')).toBe(false);
    await s.commit('z', t as string, 60);
    expect(await s.state('z')).toBe('recorded');
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
    await verifyGitHubWebhook({
      secretResolver: resolver(),
      rawBody: body,
      headers: headers(),
      deliveryStore: { markIfNew },
      replayTtlSeconds: 30,
    });
    expect(markIfNew).toHaveBeenCalledWith('72d3162e-cc78-11e3-81ab-4c9367dc0958', 604_800);
  });
});

describe('delivery id format', () => {
  it('accepts GUIDs only, bounded length', () => {
    expect(isValidGitHubDeliveryId('72d3162e-cc78-11e3-81ab-4c9367dc0958')).toBe(true);
    expect(isValidGitHubDeliveryId('72D3162E-CC78-11E3-81AB-4C9367DC0958')).toBe(true);
    for (const bad of [
      'd-1',
      '',
      '72d3162e-cc78-11e3-81ab-4c9367dc0958x',
      'x'.repeat(65),
      '72d3162e-cc78-11e3-81ab-4c9367dc0958\n',
      '../../etc',
      undefined,
    ])
      expect(isValidGitHubDeliveryId(bad)).toBe(false);
  });
  it('rejects malformed ids with 400 before the store is touched', async () => {
    const markIfNew = vi.fn(async () => true);
    for (const id of ['d-1', 'a'.repeat(500), 'key:*']) {
      expect(
        await verifyGitHubWebhook({
          secretResolver: resolver(),
          rawBody: body,
          headers: headers({ 'X-GitHub-Delivery': id }),
          deliveryStore: { markIfNew },
        }),
      ).toMatchObject({ ok: false, reason: 'malformed_delivery_id', status: 400 });
    }
    expect(markIfNew).not.toHaveBeenCalled();
  });
  it('normalizes case so upper/lower variants are the same delivery', async () => {
    const s = store();
    expect(
      (
        await verifyGitHubWebhook({
          secretResolver: resolver(),
          rawBody: body,
          headers: headers({ 'X-GitHub-Delivery': '72D3162E-CC78-11E3-81AB-4C9367DC0958' }),
          deliveryStore: s,
        })
      ).ok,
    ).toBe(true);
    expect(
      await verifyGitHubWebhook({
        secretResolver: resolver(),
        rawBody: body,
        headers: headers(),
        deliveryStore: s,
      }),
    ).toMatchObject({ reason: 'replayed_delivery' });
  });
});

describe('timestamp freshness', () => {
  const now = () => Date.parse('2026-10-22T00:00:00Z');
  it('classifies ms, s and ISO timestamps', () => {
    const t = now();
    expect(checkTimestampFreshness(t - 1000, { maxAgeSeconds: 300, now })).toBe('fresh');
    expect(checkTimestampFreshness(Math.floor(t / 1000) - 10, { maxAgeSeconds: 300, now })).toBe(
      'fresh',
    );
    expect(checkTimestampFreshness(String(t), { maxAgeSeconds: 300, now })).toBe('fresh');
    expect(checkTimestampFreshness('2026-10-21T23:59:00Z', { maxAgeSeconds: 300, now })).toBe(
      'fresh',
    );
    expect(checkTimestampFreshness(t - 301_000, { maxAgeSeconds: 300, now })).toBe('stale');
    expect(checkTimestampFreshness(t + 301_000, { maxAgeSeconds: 300, now })).toBe('future');
    expect(
      checkTimestampFreshness(t + 10_000, { maxAgeSeconds: 300, maxFutureSkewSeconds: 5, now }),
    ).toBe('future');
    for (const bad of ['nope', null, {}, Number.NaN])
      expect(checkTimestampFreshness(bad, { maxAgeSeconds: 300, now })).toBe('invalid');
    expect(checkTimestampFreshness(t, { maxAgeSeconds: 0, now })).toBe('invalid');
  });
  it('reads the Jira payload timestamp field', () => {
    expect(
      checkJiraWebhookFreshness(
        { timestamp: now() - 5000, webhookEvent: 'jira:issue_updated' },
        { maxAgeSeconds: 300, now },
      ),
    ).toBe('fresh');
    expect(
      checkJiraWebhookFreshness({ timestamp: now() - 3_600_000 }, { maxAgeSeconds: 300, now }),
    ).toBe('stale');
    expect(checkJiraWebhookFreshness({}, { maxAgeSeconds: 300, now })).toBe('absent');
    expect(checkJiraWebhookFreshness({}, { maxAgeSeconds: 300, now, requireTimestamp: true })).toBe(
      'invalid',
    );
  });
});

describe('recordDelivery (check -> beforeRecord -> SET NX)', () => {
  it('records nothing when beforeRecord throws, so a retry is not a replay', async () => {
    const { InMemoryDeliveryStore, recordDelivery } = await import('../src/webhook.js');
    const s = new InMemoryDeliveryStore();
    const limited = async () => {
      throw new Error('429');
    };
    await expect(recordDelivery(s, 'd1', 60, limited)).rejects.toThrow('429');
    expect(await s.isRecorded('d1')).toBe(false);
    expect(await recordDelivery(s, 'd1', 60, async () => {})).toBe(true);
    expect(await recordDelivery(s, 'd1', 60, async () => {})).toBe(false);
  });
  it('a known replay is rejected before beforeRecord runs; a concurrent duplicate loses SET NX', async () => {
    const { InMemoryDeliveryStore, recordDelivery } = await import('../src/webhook.js');
    const s = new InMemoryDeliveryStore();
    await s.markIfNew('d2', 60);
    let charged = 0;
    expect(await recordDelivery(s, 'd2', 60, async () => void charged++)).toBe(false);
    expect(charged).toBe(0);
    const results = await Promise.all([
      recordDelivery(s, 'd3', 60, async () => void charged++),
      recordDelivery(s, 'd3', 60, async () => void charged++),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(charged).toBe(1); // the pending claim stops the losing duplicate before it charges
  });
});

describe('follow-ups: fail-closed env, in-progress, release errors, claim loss, pending prune', () => {
  it.each([undefined, 'production', 'Production', 'prod', 'staging'])(
    'InMemoryDeliveryStore refuses NODE_ENV=%s',
    async (nodeEnv) => {
      const { InMemoryDeliveryStore } = await import('../src/webhook.js');
      expect(() => new InMemoryDeliveryStore({ nodeEnv })).toThrow(
        /not allowed outside development\/test/,
      );
    },
  );
  it('a duplicate during a pending claim is in_progress, not replayed', async () => {
    const { InMemoryDeliveryStore, recordDeliveryOutcome } = await import('../src/webhook.js');
    const s = new InMemoryDeliveryStore({ nodeEnv: 'test' });
    await s.claim('p', 30);
    expect(await recordDeliveryOutcome(s, 'p', 60)).toBe('in_progress');
    await s.markIfNew('r', 60);
    expect(await recordDeliveryOutcome(s, 'r', 60)).toBe('replayed');
  });
  it('a failing release rethrows the original error', async () => {
    const { InMemoryDeliveryStore, recordDelivery } = await import('../src/webhook.js');
    const s = new InMemoryDeliveryStore({ nodeEnv: 'test' });
    s.release = async () => {
      throw new Error('redis down');
    };
    const limited = async () => {
      throw new Error('429');
    };
    await expect(recordDelivery(s, 'x', 60, limited)).rejects.toThrow('429');
  });
  it('a claim that expires before commit warns and reports in_progress', async () => {
    const { InMemoryDeliveryStore, recordDeliveryOutcome } = await import('../src/webhook.js');
    let now = 1_000_000;
    const s = new InMemoryDeliveryStore({ nodeEnv: 'test', now: () => now });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const outcome = await recordDeliveryOutcome(s, 'slow', 60, async () => {
      now += 31_000; // longer than the 30 s pending TTL
    });
    expect(outcome).toBe('in_progress');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('claim expired'), {
      event: 'webhook_delivery_claim_lost',
    });
    warn.mockRestore();
  });
  it('expired pending claims are pruned', async () => {
    const { InMemoryDeliveryStore } = await import('../src/webhook.js');
    let now = 1_000_000;
    const s = new InMemoryDeliveryStore({ nodeEnv: 'test', now: () => now });
    for (const id of ['a', 'b', 'c']) await s.claim(id, 30);
    now += 31_000;
    await s.claim('d', 30);
    expect((s as unknown as { pending: Map<string, unknown> }).pending.size).toBe(1);
  });
});
