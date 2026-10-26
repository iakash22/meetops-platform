import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { ApiErrorEnvelope, Meeting, ResolveMeetingResponse } from '@meetops/contracts';
import { InMemoryAuditLog } from '../src/modules/auth/domain/audit.js';
import { SessionVerifier } from '../src/modules/auth/application/session-verifier.js';
import {
  defaultModuleDeps,
  MissingProductionDependencyError,
  type ModuleDeps,
} from '../src/modules/index.js';
import { InMemoryMeetingRepository } from '../src/modules/meetings/infrastructure/in-memory.repository.js';
import {
  deriveExternalMeetingId,
  InvalidExternalMeetingError,
} from '../src/modules/meetings/domain/meeting.js';
import { buildApp, signupAndLogin, SID, type App, type Client } from './helpers.js';

const MISSING = '00000000-0000-4000-8000-0000000000ff';
type Role = 'admin' | 'member' | 'viewer';

describe('meetings module (list, detail, resolve, meeting access)', () => {
  let app: App;
  let audit: InMemoryAuditLog;
  let meetings: InMemoryMeetingRepository;
  let deps: ModuleDeps;
  beforeEach(async () => {
    audit = new InMemoryAuditLog();
    meetings = new InMemoryMeetingRepository();
    deps = defaultModuleDeps({ audit, meetings });
    app = await buildApp(deps);
  });
  afterEach(async () => app.close());

  const createOrg = async (c: Client, name: string) =>
    (await c.post('/orgs', { name })).json<{ organization: { id: string } }>().organization.id;

  async function join(owner: Client, orgId: string, email: string, role: Role) {
    const c = await signupAndLogin(app, email);
    expect((await owner.post(`/orgs/${orgId}/invitations`, { email, role })).statusCode).toBe(201);
    const sent = [...app.mail.sent].reverse().find((m) => m.template === 'invitation');
    const token = new URL(sent!.data.url!).searchParams.get('token')!;
    expect((await c.post('/invitations/accept', { token })).statusCode).toBe(200);
    expect((await c.post('/orgs/switch', { organizationId: orgId })).statusCode).toBe(200);
    return c;
  }

  async function world() {
    const owner = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(owner, 'Acme');
    const member = await join(owner, org, 'member@example.com', 'member');
    const viewer = await join(owner, org, 'viewer@example.com', 'viewer');
    const other = await signupAndLogin(app, 'other@example.com');
    const otherOrg = await createOrg(other, 'Globex');
    return { owner, org, member, viewer, other, otherOrg };
  }

  const errorOf = (r: { json: () => unknown }) => {
    const body = r.json();
    expect(Value.Check(ApiErrorEnvelope, body)).toBe(true);
    return (body as { error: { code: string; reason?: string; message: string } }).error;
  };

  it('resolve is idempotent per (org, source, externalMeetingId): 201 created then 200 same id', async () => {
    const { member, org } = await world();
    const url = `/orgs/${org}/meetings/resolve`;
    const body = {
      source: 'extension',
      externalMeetingUrl: 'https://Meet.Google.com/abc-defg-hij?authuser=0',
      title: 'Standup',
    };
    const a = await member.post(url, body);
    expect(a.statusCode).toBe(201);
    expect(Value.Check(ResolveMeetingResponse, a.json())).toBe(true);
    expect(a.json().created).toBe(true);
    const b = await member.post(url, {
      source: 'extension',
      externalMeetingId: 'meet.google.com/abc-defg-hij',
    });
    expect(b.statusCode).toBe(200);
    expect(b.json()).toEqual({ meetingId: a.json().meetingId, created: false });
    // Different source = different meeting.
    const d = await member.post(url, {
      source: 'desktop',
      externalMeetingId: 'meet.google.com/abc-defg-hij',
    });
    expect(d.statusCode).toBe(201);
    expect(d.json().meetingId).not.toBe(a.json().meetingId);
    // Concurrent resolves converge.
    const [x, y] = await Promise.all([
      member.post(url, { source: 'extension', externalMeetingId: 'zoom-1' }),
      member.post(url, { source: 'extension', externalMeetingId: 'zoom-1' }),
    ]);
    expect(x.json().meetingId).toBe(y.json().meetingId);
    expect([x.json().created, y.json().created].filter(Boolean)).toHaveLength(1);
    expect(audit.events.filter((e) => e.action === 'meeting.create')).toHaveLength(3);
  });

  it('resolve validates input (400 VALIDATION_FAILED), enforces CSRF and CASL (viewer 403)', async () => {
    const { member, viewer, org, owner } = await world();
    const url = `/orgs/${org}/meetings/resolve`;
    expect(errorOf(await member.post(url, { source: 'extension' })).code).toBe('VALIDATION_FAILED');
    expect(
      errorOf(
        await member.post(url, {
          source: 'extension',
          externalMeetingId: 'x',
          organizationId: org,
        }),
      ).code,
    ).toBe('VALIDATION_FAILED');
    expect(
      errorOf(
        await member.post(url, {
          source: 'extension',
          externalMeetingUrl: 'http://meet.google.com/a',
        }),
      ).code,
    ).toBe('VALIDATION_FAILED');
    const v = await viewer.post(url, { source: 'extension', externalMeetingId: 'v1' });
    expect(v.statusCode).toBe(403);
    const noCsrf = await app.inject({
      method: 'POST',
      url,
      payload: { source: 'extension', externalMeetingId: 'c1' },
      headers: { cookie: owner.cookie, origin: 'http://localhost:5173' },
    });
    expect(noCsrf.statusCode).toBe(403);
    expect(errorOf(noCsrf).code).toBe('CSRF_INVALID');
    expect(meetings.rows.size).toBe(0);
  });

  it('list is cursor-paginated newest first and detail returns a contract-valid Meeting', async () => {
    const { viewer, org, otherOrg } = await world();
    const t0 = Date.parse('2026-10-01T00:00:00Z');
    for (let i = 0; i < 5; i++)
      meetings.seed({ organizationId: org, title: `M${i}`, createdAt: new Date(t0 + i * 1000) });
    meetings.seed({ organizationId: org, title: 'gone', deletedAt: new Date() });
    meetings.seed({ organizationId: otherOrg, title: 'theirs' });
    const p1 = await viewer.get(`/orgs/${org}/meetings?limit=2`);
    expect(p1.statusCode).toBe(200);
    expect(p1.json().items.map((m: { title: string }) => m.title)).toEqual(['M4', 'M3']);
    for (const m of p1.json().items) expect(Value.Check(Meeting, m)).toBe(true);
    const p2 = await viewer.get(`/orgs/${org}/meetings?limit=2&cursor=${p1.json().nextCursor}`);
    expect(p2.json().items.map((m: { title: string }) => m.title)).toEqual(['M2', 'M1']);
    const p3 = await viewer.get(`/orgs/${org}/meetings?limit=2&cursor=${p2.json().nextCursor}`);
    expect(p3.json()).toMatchObject({ nextCursor: null });
    expect(p3.json().items.map((m: { title: string }) => m.title)).toEqual(['M0']);
    expect((await viewer.get(`/orgs/${org}/meetings`)).json().items).toHaveLength(5);
    expect(errorOf(await viewer.get(`/orgs/${org}/meetings?cursor=bogus`)).code).toBe(
      'BAD_REQUEST',
    );
    expect(errorOf(await viewer.get(`/orgs/${org}/meetings?limit=101`)).code).toBe(
      'VALIDATION_FAILED',
    );

    const id = p1.json().items[0].id as string;
    const one = await viewer.get(`/orgs/${org}/meetings/${id}`);
    expect(one.statusCode).toBe(200);
    expect(Value.Check(Meeting, one.json())).toBe(true);
    expect(one.json()).toMatchObject({ id, organizationId: org, title: 'M4', createdById: null });
  });

  it('tenant isolation: other-org, deleted and missing meetings return an identical 404', async () => {
    const { owner, org, other, otherOrg } = await world();
    const theirs = meetings.seed({ organizationId: otherOrg });
    const gone = meetings.seed({ organizationId: org, deletedAt: new Date() });
    const bodies = [];
    for (const id of [theirs.id, gone.id, MISSING]) {
      const r = await owner.get(`/orgs/${org}/meetings/${id}`);
      expect(r.statusCode).toBe(404);
      const { requestId, ...rest } = r.json().error;
      void requestId;
      bodies.push(rest);
    }
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toEqual(bodies[2]);
    expect(bodies[0]).toEqual({ code: 'NOT_FOUND', message: 'Meeting not found' });
    // Non-member org path: 404 like an unknown org, for list, detail and resolve.
    expect((await other.get(`/orgs/${org}/meetings`)).statusCode).toBe(404);
    expect((await other.get(`/orgs/${org}/meetings/${gone.id}`)).statusCode).toBe(404);
    expect(
      (await other.post(`/orgs/${org}/meetings/resolve`, { source: 'bot', externalMeetingId: 'x' }))
        .statusCode,
    ).toBe(404);
    expect((await owner.get(`/orgs/${otherOrg}/meetings/${theirs.id}`)).statusCode).toBe(404);
    // Unauthenticated.
    expect((await app.inject({ method: 'GET', url: `/orgs/${org}/meetings` })).statusCode).toBe(
      401,
    );
  });

  it('SessionVerifier.canAccessMeeting is a real org-scoped lookup; other-org, deleted, missing, malformed all false', async () => {
    const { owner, org, otherOrg } = await world();
    const v = new SessionVerifier(deps);
    const session = (await v.verify(owner.jar.get(SID)))!;
    expect(session.organizationId).toBe(org);
    const mine = meetings.seed({ organizationId: org });
    const theirs = meetings.seed({ organizationId: otherOrg });
    const gone = meetings.seed({ organizationId: org, deletedAt: new Date() });
    expect(await v.canAccessMeeting(session, mine.id)).toBe(true);
    expect(await v.canAccessMeeting(session, theirs.id)).toBe(false);
    expect(await v.canAccessMeeting(session, gone.id)).toBe(false);
    expect(await v.canAccessMeeting(session, MISSING)).toBe(false);
    expect(await v.canAccessMeeting(session, 'm1')).toBe(false);
    // Fails closed on repository errors.
    const broken = new SessionVerifier({
      ...deps,
      meetings: {
        ...meetings,
        findById: () => Promise.reject(new Error('db down')),
      } as unknown as InMemoryMeetingRepository,
    });
    expect(await broken.canAccessMeeting(session, mine.id)).toBe(false);
  });

  it('derives externalMeetingId from URLs and rejects ones outside the contract charset', () => {
    expect(deriveExternalMeetingId('https://Zoom.US/j/123456789/?pwd=x#y')).toBe(
      'zoom.us/j/123456789',
    );
    expect(() =>
      deriveExternalMeetingId('https://teams.microsoft.com/l/meetup-join/19%3a'),
    ).toThrow(InvalidExternalMeetingError);
  });

  it('refuses to start in strict environments without a meetings repository', () => {
    expect(() =>
      defaultModuleDeps(
        {
          security: deps.security,
          ...Object.fromEntries(
            [
              'users',
              'sessions',
              'oneTimeTokens',
              'organizations',
              'memberships',
              'invitations',
              'rateLimiter',
              'lockout',
              'mailQueue',
              'audit',
            ].map((k) => [k, (deps as unknown as Record<string, unknown>)[k]]),
          ),
        },
        { nodeEnv: 'production' },
      ),
    ).toThrow(MissingProductionDependencyError);
  });
});
