import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { ApiErrorEnvelope, MeetingAnalytics } from '@meetops/contracts';
import { defaultModuleDeps } from '../src/modules/index.js';
import { InMemoryMeetingRepository } from '../src/modules/meetings/infrastructure/in-memory.repository.js';
import { bucketStart } from '../src/modules/meetings/domain/meeting.js';
import { buildApp, signupAndLogin, type App, type Client } from './helpers.js';

const FROM = '2026-10-01T00:00:00.000Z';
const TO = '2026-11-01T00:00:00.000Z';
const at = (iso: string) => new Date(iso);

describe('meeting analytics (P7, read-only, org-scoped)', () => {
  let app: App;
  let meetings: InMemoryMeetingRepository;
  beforeEach(async () => {
    meetings = new InMemoryMeetingRepository();
    app = await buildApp(defaultModuleDeps({ meetings }));
  });
  afterEach(async () => app.close());

  const createOrg = async (c: Client, name: string) =>
    (await c.post('/orgs', { name })).json<{ organization: { id: string } }>().organization.id;

  async function join(owner: Client, orgId: string, email: string, role: 'viewer' | 'member') {
    const c = await signupAndLogin(app, email);
    expect((await owner.post(`/orgs/${orgId}/invitations`, { email, role })).statusCode).toBe(201);
    const sent = [...app.mail.sent].reverse().find((m) => m.template === 'invitation');
    const token = new URL(sent!.data.url!).searchParams.get('token')!;
    expect((await c.post('/invitations/accept', { token })).statusCode).toBe(200);
    expect((await c.post('/orgs/switch', { organizationId: orgId })).statusCode).toBe(200);
    return c;
  }

  const url = (org: string, q: Record<string, string> = { from: FROM, to: TO }) =>
    `/orgs/${org}/analytics/meetings?${new URLSearchParams(q).toString()}`;

  async function world() {
    const owner = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(owner, 'Acme');
    const viewer = await join(owner, org, 'viewer@example.com', 'viewer');
    const other = await signupAndLogin(app, 'other@example.com');
    const otherOrg = await createOrg(other, 'Globex');
    return { owner, org, viewer, other, otherOrg };
  }

  it('aggregates by source, status, period and duration for the caller org only', async () => {
    const { org, viewer, otherOrg } = await world();
    meetings.seed({
      organizationId: org,
      source: 'upload',
      status: 'completed',
      durationSec: 600,
      createdAt: at('2026-10-05T10:00:00Z'),
    });
    meetings.seed({
      organizationId: org,
      source: 'extension',
      status: 'processing',
      durationSec: 1200,
      createdAt: at('2026-10-05T23:59:59Z'),
    });
    meetings.seed({
      organizationId: org,
      source: 'extension',
      status: 'failed',
      createdAt: at('2026-10-20T08:00:00Z'),
    });
    // Excluded: soft-deleted, out of range (to is exclusive), other org.
    meetings.seed({
      organizationId: org,
      source: 'desktop',
      createdAt: at('2026-10-06T00:00:00Z'),
      deletedAt: at('2026-10-07T00:00:00Z'),
    });
    meetings.seed({ organizationId: org, source: 'bot', createdAt: at(TO) });
    meetings.seed({
      organizationId: otherOrg,
      source: 'bot',
      durationSec: 9999,
      createdAt: at('2026-10-05T10:00:00Z'),
    });

    const r = await viewer.get(url(org));
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('private, no-store');
    const body = r.json<MeetingAnalytics>();
    expect(Value.Check(MeetingAnalytics, body)).toBe(true);
    expect(body).toEqual({
      organizationId: org,
      from: FROM,
      to: TO,
      bucket: 'day',
      total: 3,
      bySource: [
        { source: 'extension', count: 2 },
        { source: 'upload', count: 1 },
      ],
      byStatus: [
        { status: 'completed', count: 1 },
        { status: 'failed', count: 1 },
        { status: 'processing', count: 1 },
      ],
      duration: { measured: 2, totalSec: 1800, averageSec: 900 },
      periods: [
        { start: '2026-10-05T00:00:00.000Z', count: 2 },
        { start: '2026-10-20T00:00:00.000Z', count: 1 },
      ],
    });
    const m = await viewer.get(url(org, { from: FROM, to: TO, bucket: 'month' }));
    expect(m.json<MeetingAnalytics>().periods).toEqual([{ start: FROM, count: 3 }]);
  });

  it('an empty org gets zeros, no buckets and a null average', async () => {
    const { owner, org } = await world();
    const r = await owner.get(url(org));
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      total: 0,
      bySource: [],
      byStatus: [],
      duration: { measured: 0, totalSec: 0, averageSec: null },
      periods: [],
    });
  });

  it('another org (or a non-member) gets 404, an unauthenticated caller 401', async () => {
    const { org, other } = await world();
    expect((await other.get(url(org))).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: url(org) })).statusCode).toBe(401);
  });

  it('validates and caps the range', async () => {
    const { owner, org } = await world();
    const bad = async (q: Record<string, string>) => {
      const r = await owner.get(url(org, q));
      expect(r.statusCode).toBe(400);
      expect(Value.Check(ApiErrorEnvelope, r.json())).toBe(true);
    };
    await bad({ from: FROM });
    await bad({ from: 'yesterday', to: TO });
    await bad({ from: TO, to: FROM });
    await bad({ from: FROM, to: FROM });
    await bad({ from: '2025-01-01T00:00:00Z', to: '2026-01-03T00:00:00Z' }); // 367 days
    await bad({ from: FROM, to: TO, bucket: 'year' });
    await bad({ from: FROM, to: TO, extra: '1' });
    const max = await owner.get(
      url(org, { from: '2025-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' }),
    );
    expect(max.statusCode).toBe(200);
  });
});

describe('bucketStart (UTC, weeks start Monday like date_trunc)', () => {
  it('truncates', () => {
    const d = at('2026-10-31T17:45:00Z'); // Saturday
    expect(bucketStart(d, 'day').toISOString()).toBe('2026-10-31T00:00:00.000Z');
    expect(bucketStart(d, 'week').toISOString()).toBe('2026-10-26T00:00:00.000Z');
    expect(bucketStart(at('2026-11-01T01:00:00Z'), 'week').toISOString()).toBe(
      '2026-10-26T00:00:00.000Z',
    );
    expect(bucketStart(d, 'month').toISOString()).toBe('2026-10-01T00:00:00.000Z');
  });
});
