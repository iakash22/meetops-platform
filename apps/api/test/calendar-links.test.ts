import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { CalendarEventLink, CalendarEventList } from '@meetops/contracts';
import { GOOGLE_CALENDAR_SCOPES } from '@meetops/integrations';
import { InMemoryAuditLog } from '../src/modules/auth/domain/audit.js';
import { InMemoryCalendarConnections } from '../src/modules/calendar/in-memory.repository.js';
import { InMemoryCalendarEventLinks } from '../src/modules/calendar/links.repository.js';
import { InMemoryMeetingRepository } from '../src/modules/meetings/infrastructure/in-memory.repository.js';
import { devIntegrationsRuntime } from '../src/modules/integrations/runtime.js';
import { defaultModuleDeps, type ModuleDeps } from '../src/modules/index.js';
import { buildApp, signupAndLogin, type App, type Client } from './helpers.js';

const API = 'http://localhost:4000';
const SCOPE = GOOGLE_CALENDAR_SCOPES.join(' ');
const FROM = '2026-11-01T00:00:00.000Z';
const TO = '2026-11-08T00:00:00.000Z';
const MISSING = '00000000-0000-4000-8000-0000000000ff';
const MEET_EXT = 'meet.google.com/abc-defg-hij';
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

describe('P7 calendar event <-> meeting links', () => {
  let app: App;
  let audit: InMemoryAuditLog;
  let meetings: InMemoryMeetingRepository;
  let links: InMemoryCalendarEventLinks;
  let conns: InMemoryCalendarConnections;

  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    const key = `${init?.method ?? 'GET'} ${url.split('?')[0]}`;
    switch (key) {
      case 'POST https://oauth2.googleapis.com/token':
        return json({
          access_token: 'g-access',
          refresh_token: 'g-refresh',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: SCOPE,
        });
      case 'GET https://www.googleapis.com/calendar/v3/users/me/calendarList/primary':
        return json({ id: 'me@example.test', summary: 'Me' });
      case 'GET https://www.googleapis.com/calendar/v3/calendars/primary/events':
        return json({
          items: [
            {
              id: 'ev1',
              summary: 'Weekly sync',
              start: { dateTime: '2026-11-02T10:00:00Z' },
              end: { dateTime: '2026-11-02T10:30:00Z' },
              hangoutLink: `https://${MEET_EXT}`,
            },
            {
              id: 'ev2',
              summary: 'No call',
              start: { dateTime: '2026-11-03T10:00:00Z' },
              end: { dateTime: '2026-11-03T10:30:00Z' },
            },
          ],
        });
      default:
        return json({ error: 'unexpected' }, 500);
    }
  };

  beforeEach(async () => {
    audit = new InMemoryAuditLog();
    meetings = new InMemoryMeetingRepository();
    links = new InMemoryCalendarEventLinks(() => meetings.rows.values());
    conns = new InMemoryCalendarConnections();
    app = await buildApp({
      ...defaultModuleDeps({ audit, meetings }),
      calendarConnections: conns,
      calendarEventLinks: links,
      integrationsRuntime: devIntegrationsRuntime({
        apiOrigin: API,
        fetch: fetchFn,
        googleCalendar: { clientId: 'gcal-client', clientSecret: async () => 'gcal-secret' },
      }),
    } as Partial<ModuleDeps>);
  });
  afterEach(async () => app.close());

  const createOrg = async (c: Client, name: string) =>
    (await c.post('/orgs', { name })).json<{ organization: { id: string } }>().organization.id;
  async function join(owner: Client, orgId: string, email: string, role: 'member' | 'viewer') {
    const c = await signupAndLogin(app, email);
    expect((await owner.post(`/orgs/${orgId}/invitations`, { email, role })).statusCode).toBe(201);
    const sent = [...app.mail.sent].reverse().find((m) => m.template === 'invitation');
    const token = new URL(sent!.data.url!).searchParams.get('token')!;
    expect((await c.post('/invitations/accept', { token })).statusCode).toBe(200);
    expect((await c.post('/orgs/switch', { organizationId: orgId })).statusCode).toBe(200);
    return c;
  }
  async function connect(c: Client, org: string) {
    const res = await c.post(`/orgs/${org}/calendar/connect`, { provider: 'google' });
    const state = new URL(res.json<{ authorizeUrl: string }>().authorizeUrl).searchParams.get(
      'state',
    )!;
    expect((await c.get(`/calendar/google/callback?state=${state}&code=abc`)).statusCode).toBe(302);
    const providers = await c.get(`/orgs/${org}/calendar/providers`);
    return providers.json<{ items: { connection: { id: string } }[] }>().items[0]!.connection.id;
  }
  const events = async (c: Client, org: string) => {
    const r = await c.get(`/orgs/${org}/calendar/events?from=${FROM}&to=${TO}`);
    expect(r.statusCode).toBe(200);
    expect(Value.Check(CalendarEventList, r.json())).toBe(true);
    return r.json<CalendarEventList>().items;
  };
  const linkUrl = (org: string, conn: string, ev: string) =>
    `/orgs/${org}/calendar/connections/${conn}/events/${ev}/link`;

  async function world() {
    const owner = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(owner, 'Acme');
    const conn = await connect(owner, org);
    return { owner, org, conn };
  }

  it('suggests the meeting resolved from the conference URL, links, re-links and unlinks', async () => {
    const { owner, org, conn } = await world();
    const call = meetings.seed({
      organizationId: org,
      source: 'extension',
      externalMeetingId: MEET_EXT,
    });
    const upload = meetings.seed({ organizationId: org });

    let items = await events(owner, org);
    expect(items.find((e) => e.id === 'ev1')).toMatchObject({ suggestedMeetingId: call.id });
    expect(items.find((e) => e.id === 'ev1')!.meetingId).toBeUndefined();
    expect(items.find((e) => e.id === 'ev2')!.suggestedMeetingId).toBeUndefined();

    const put = await owner.put(linkUrl(org, conn, 'ev1'), { meetingId: upload.id });
    expect(put.statusCode).toBe(200);
    expect(Value.Check(CalendarEventLink, put.json())).toBe(true);
    expect(put.json()).toMatchObject({ connectionId: conn, eventId: 'ev1', meetingId: upload.id });
    items = await events(owner, org);
    const ev1 = items.find((e) => e.id === 'ev1')!;
    expect(ev1.meetingId).toBe(upload.id);
    expect(ev1.suggestedMeetingId).toBeUndefined();

    // Re-link replaces the meeting (one link per event).
    expect((await owner.put(linkUrl(org, conn, 'ev1'), { meetingId: call.id })).statusCode).toBe(
      200,
    );
    expect(links.rows.size).toBe(1);
    expect((await events(owner, org)).find((e) => e.id === 'ev1')!.meetingId).toBe(call.id);
    expect(audit.events.filter((e) => e.action === 'calendar.link')).toHaveLength(2);

    expect((await owner.delete(linkUrl(org, conn, 'ev1'))).statusCode).toBe(204);
    expect((await owner.delete(linkUrl(org, conn, 'ev1'))).statusCode).toBe(404);
    expect(audit.events.some((e) => e.action === 'calendar.unlink')).toBe(true);
    expect((await events(owner, org)).find((e) => e.id === 'ev1')).toMatchObject({
      suggestedMeetingId: call.id,
    });
  });

  it('no suggestion when the conference URL matches more than one meeting', async () => {
    const { owner, org } = await world();
    meetings.seed({ organizationId: org, source: 'extension', externalMeetingId: MEET_EXT });
    meetings.seed({ organizationId: org, source: 'desktop', externalMeetingId: MEET_EXT });
    expect((await events(owner, org)).find((e) => e.id === 'ev1')!.suggestedMeetingId).toBe(
      undefined,
    );
  });

  it('cross-org isolation: other-org, deleted and missing meetings give the same 404; other orgs never suggest', async () => {
    const { owner, org, conn } = await world();
    const other = await signupAndLogin(app, 'other@example.com');
    const otherOrg = await createOrg(other, 'Globex');
    const theirs = meetings.seed({
      organizationId: otherOrg,
      source: 'extension',
      externalMeetingId: MEET_EXT,
    });
    const gone = meetings.seed({ organizationId: org, deletedAt: new Date() });

    const bodies = [];
    for (const id of [theirs.id, gone.id, MISSING]) {
      const r = await owner.put(linkUrl(org, conn, 'ev1'), { meetingId: id });
      expect(r.statusCode).toBe(404);
      const err = r.json<{ error: Record<string, unknown> }>().error;
      delete err.requestId;
      bodies.push(err);
    }
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toEqual(bodies[2]);
    expect(links.rows.size).toBe(0);
    // The other org's meeting with the same Meet link is never suggested.
    expect((await events(owner, org)).find((e) => e.id === 'ev1')!.suggestedMeetingId).toBe(
      undefined,
    );

    // A non-member using this org's path, or this connection from another org path: 404.
    expect((await other.put(linkUrl(org, conn, 'ev1'), { meetingId: theirs.id })).statusCode).toBe(
      404,
    );
    expect(
      (await other.put(linkUrl(otherOrg, conn, 'ev1'), { meetingId: theirs.id })).statusCode,
    ).toBe(404);
    expect((await other.delete(linkUrl(org, conn, 'ev1'))).statusCode).toBe(404);
    // Unauthenticated: the mutation guard (no Origin/CSRF) or the session check refuses it.
    const anon = await app.inject({ method: 'DELETE', url: linkUrl(org, conn, 'ev1') });
    expect([401, 403]).toContain(anon.statusCode);
    expect(links.rows.size).toBe(0);
  });

  it("members can't touch another member's connection; viewers can't link", async () => {
    const { owner, org, conn } = await world();
    const m = meetings.seed({ organizationId: org });
    const member = await join(owner, org, 'member@example.com', 'member');
    const r = await member.put(linkUrl(org, conn, 'ev1'), { meetingId: m.id });
    expect(r.statusCode).toBe(404);
    expect(r.json<{ error: { message: string } }>().error.message).toBe(
      'Calendar connection not found',
    );
    expect((await owner.put(linkUrl(org, conn, 'ev1'), { meetingId: m.id })).statusCode).toBe(200);
    expect((await member.delete(linkUrl(org, conn, 'ev1'))).statusCode).toBe(404);
    expect(links.rows.size).toBe(1);

    const viewer = await join(owner, org, 'viewer@example.com', 'viewer');
    const vconn = await connect(viewer, org);
    expect((await viewer.put(linkUrl(org, vconn, 'ev1'), { meetingId: m.id })).statusCode).toBe(
      403,
    );
  });

  it('a soft-deleted linked meeting is not exposed; disconnect drops the links; bad event ids are 400', async () => {
    const { owner, org, conn } = await world();
    const m = meetings.seed({ organizationId: org });
    expect((await owner.put(linkUrl(org, conn, 'ev2'), { meetingId: m.id })).statusCode).toBe(200);
    meetings.rows.set(m.id, { ...meetings.rows.get(m.id)!, deletedAt: new Date() });
    expect((await events(owner, org)).find((e) => e.id === 'ev2')!.meetingId).toBeUndefined();

    expect((await owner.put(linkUrl(org, conn, 'ev%20x'), { meetingId: m.id })).statusCode).toBe(
      400,
    );
    expect((await owner.delete(`/orgs/${org}/calendar/connections/${conn}`)).statusCode).toBe(204);
    expect(links.rows.size).toBe(0);
    expect((await owner.put(linkUrl(org, conn, 'ev2'), { meetingId: m.id })).statusCode).toBe(404);
  });
});

describe('InMemoryCalendarEventLinks soft unlink', () => {
  it('hides a removed link, refuses a second removal and revives it on a manual re-link', async () => {
    const ORG = '00000000-0000-4000-8000-00000000000a';
    const M = '00000000-0000-4000-8000-0000000000d1';
    const links = new InMemoryCalendarEventLinks(() => [
      { id: M, organizationId: ORG, externalMeetingId: null, deletedAt: null } as never,
    ]);
    const l = { connectionId: 'c1', eventId: 'e1', meetingId: M };
    await links.upsert(ORG, 'u1', l);
    expect(await links.remove(ORG, 'u1', 'c1', 'e1')).toBe(true);
    expect(await links.remove(ORG, 'u1', 'c1', 'e1')).toBe(false);
    expect(await links.listForUser(ORG, 'u1', ['c1'])).toEqual([]);
    expect(links.rows.size).toBe(1); // tombstone kept for the worker's auto-link
    await links.upsert(ORG, 'u1', l);
    expect((await links.listForUser(ORG, 'u1', ['c1'])).map((x) => x.eventId)).toEqual(['e1']);
  });
});
