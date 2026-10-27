import { createHmac } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { InMemoryDeliveryStore, mapJiraIssueEvent, verifyJiraWebhook } from '../src';

const SECRET = 'whsec_jira';
const NOW = 1_800_000_000_000;
const sign = (b: string, s = SECRET) => `sha256=${createHmac('sha256', s).update(b).digest('hex')}`;
const body = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    webhookEvent: 'jira:issue_updated',
    timestamp: NOW - 1000,
    issue: { key: 'MEET-7', fields: { status: { statusCategory: { key: 'done' } } } },
    ...over,
  });

function verify(
  raw: string,
  headers: Record<string, string>,
  store = new InMemoryDeliveryStore({ nodeEnv: 'test' }),
) {
  return verifyJiraWebhook({
    secret: SECRET,
    integrationId: 'int1',
    rawBody: raw,
    headers,
    deliveryStore: store,
    now: () => NOW,
  });
}

describe('verifyJiraWebhook', () => {
  it('accepts a signed, fresh, first-seen delivery and rejects the replay', async () => {
    const raw = body();
    const store = new InMemoryDeliveryStore({ nodeEnv: 'test' });
    const h = { 'x-hub-signature': sign(raw), 'x-atlassian-webhook-identifier': 'abc-1' };
    expect(await verify(raw, h, store)).toMatchObject({ ok: true, deliveryId: 'jira:int1:abc-1' });
    expect(await verify(raw, h, store)).toEqual({
      ok: false,
      reason: 'replayed_delivery',
      status: 409,
    });
  });
  it('rejects bad, missing or wrong-secret signatures before marking the delivery', async () => {
    const raw = body();
    const store = new InMemoryDeliveryStore({ nodeEnv: 'test' });
    expect(await verify(raw, { 'x-atlassian-webhook-identifier': 'a' }, store)).toMatchObject({
      reason: 'missing_signature',
      status: 401,
    });
    expect(
      await verify(
        raw,
        { 'x-hub-signature': sign(raw, 'other'), 'x-atlassian-webhook-identifier': 'a' },
        store,
      ),
    ).toMatchObject({ reason: 'invalid_signature' });
    expect(
      await verify(
        raw,
        { 'x-hub-signature': 'sha1=00', 'x-atlassian-webhook-identifier': 'a' },
        store,
      ),
    ).toMatchObject({ reason: 'malformed_signature' });
    expect(
      await verify(
        raw,
        { 'x-hub-signature': sign(raw), 'x-atlassian-webhook-identifier': 'a' },
        store,
      ),
    ).toMatchObject({ ok: true });
  });
  it('rejects stale events, missing ids, bad JSON and oversized bodies', async () => {
    const stale = body({ timestamp: NOW - 2 * 86_400_000 });
    expect(
      await verify(stale, {
        'x-hub-signature': sign(stale),
        'x-atlassian-webhook-identifier': 'b',
      }),
    ).toMatchObject({ reason: 'stale_event' });
    const raw = body();
    expect(await verify(raw, { 'x-hub-signature': sign(raw) })).toMatchObject({
      reason: 'missing_delivery_id',
      status: 400,
    });
    expect(
      await verify('{', { 'x-hub-signature': sign('{'), 'x-atlassian-webhook-identifier': 'c' }),
    ).toMatchObject({ reason: 'invalid_payload' });
    const big = 'x'.repeat(1024 * 1024 + 1);
    expect(
      await verify(big, { 'x-hub-signature': sign(big), 'x-atlassian-webhook-identifier': 'd' }),
    ).toMatchObject({ status: 413 });
  });
});

describe('mapJiraIssueEvent', () => {
  const ctx = { organizationId: 'o', integrationId: 'i' };
  it('maps status categories by issue key', () => {
    for (const [cat, status] of [
      ['new', 'open'],
      ['indeterminate', 'in_progress'],
      ['done', 'done'],
    ] as const) {
      expect(
        mapJiraIssueEvent(
          JSON.parse(
            body({
              issue: { key: 'MEET-7', fields: { status: { statusCategory: { key: cat } } } },
            }),
          ),
          ctx,
        ),
      ).toEqual({
        ...ctx,
        provider: 'jira',
        externalId: 'MEET-7',
        status,
        action: 'jira:issue_updated',
      });
    }
  });
  it('ignores other events, unknown categories and malformed keys', () => {
    expect(
      mapJiraIssueEvent(JSON.parse(body({ webhookEvent: 'comment_created' })), ctx),
    ).toBeNull();
    expect(
      mapJiraIssueEvent(
        JSON.parse(
          body({ issue: { key: 'MEET-7', fields: { status: { statusCategory: { key: 'x' } } } } }),
        ),
        ctx,
      ),
    ).toBeNull();
    expect(
      mapJiraIssueEvent(JSON.parse(body({ issue: { key: 'bad key', fields: {} } })), ctx),
    ).toBeNull();
    expect(mapJiraIssueEvent(null, ctx)).toBeNull();
  });
});
