import { describe, it, expect, vi } from 'vitest';
import {
  CalendarProviderError,
  InMemoryOAuthStateStore,
  MICROSOFT_GRAPH_API,
  OUTLOOK_CALENDAR_SCOPES,
  OutlookCalendarProvider,
  graphApiErrorCode,
  mapOutlookEvent,
} from '../src/index.js';
import { ORG, OTHER_ORG } from './helpers.js';

const REDIRECT = 'https://api.meetops.test/calendar/outlook/callback';
const USER = 'user-1';
const SCOPE = 'Calendars.Read User.Read openid profile email';

type Res = { status: number; body?: unknown };
function fetchMock(queue: Res[]) {
  return vi.fn(async (...args: [string, unknown?]) => {
    void args;
    const r = queue.shift();
    if (!r) throw new Error('unexpected fetch');
    const text = r.body === undefined ? '' : JSON.stringify(r.body);
    return { ok: r.status < 300, status: r.status, headers: new Headers(), text: async () => text };
  });
}
const tokenRes = (over: Record<string, unknown> = {}): Res => ({
  status: 200,
  body: {
    access_token: 'placeholder-access',
    refresh_token: 'placeholder-refresh',
    expires_in: 3600,
    scope: SCOPE,
    token_type: 'Bearer',
    ...over,
  },
});
const meRes: Res = {
  status: 200,
  body: { id: 'ms-user-id', displayName: 'Me', mail: 'me@example.test' },
};

function provider(queue: Res[], tenant?: string) {
  const fetch = fetchMock(queue);
  const p = new OutlookCalendarProvider({
    clientId: 'cid',
    clientSecret: async () => 'placeholder-secret',
    redirectUriAllowlist: [REDIRECT],
    stateStore: new InMemoryOAuthStateStore(),
    fetch,
    now: () => 1_000,
    ...(tenant ? { tenant } : {}),
  });
  return { p, fetch };
}
async function connect(p: OutlookCalendarProvider) {
  const { state } = await p.beginAuthorization({
    organizationId: ORG,
    userId: USER,
    redirectUri: REDIRECT,
  });
  return p.completeAuthorization({
    state,
    code: 'auth-code',
    organizationId: ORG,
    userId: USER,
    redirectUri: REDIRECT,
  });
}
const ev = (over: Record<string, unknown> = {}) => ({
  id: 'e1',
  subject: 'Standup',
  start: { dateTime: '2026-11-02T10:00:00.0000000', timeZone: 'UTC' },
  end: { dateTime: '2026-11-02T10:30:00.0000000', timeZone: 'UTC' },
  isAllDay: false,
  isCancelled: false,
  showAs: 'busy',
  webLink: 'https://outlook.office365.com/owa/?itemid=1',
  organizer: { emailAddress: { address: 'boss@example.test' } },
  attendees: [{}, {}],
  onlineMeeting: { joinUrl: 'https://teams.microsoft.com/l/meetup-join/abc' },
  ...over,
});
const WIN = { timeMin: '2026-11-01T00:00:00Z', timeMax: '2026-11-08T00:00:00Z' };

describe('OutlookCalendarProvider', () => {
  it('builds a PKCE consent URL on the fixed Microsoft endpoint with read-only scopes', async () => {
    const { p } = provider([], 'organizations');
    const { url, state } = await p.beginAuthorization({
      organizationId: ORG,
      userId: USER,
      redirectUri: REDIRECT,
    });
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe(
      'https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize',
    );
    expect(u.searchParams.get('scope')).toBe('Calendars.Read User.Read offline_access');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('state')).toBe(state);
    expect(url).not.toContain('placeholder-secret');
  });

  it('rejects bad tenants and redirect URIs outside the allowlist', async () => {
    expect(() => provider([], 'evil.test/x')).toThrow('invalid tenant');
    const { p } = provider([]);
    await expect(
      p.beginAuthorization({
        organizationId: ORG,
        userId: USER,
        redirectUri: 'https://evil.test/cb',
      }),
    ).rejects.toThrow();
  });

  it('exchanges the code with the verifier and returns the Graph account', async () => {
    const { p, fetch } = provider([tokenRes(), meRes]);
    const done = await connect(p);
    expect(done.account).toEqual({
      externalAccountId: 'ms-user-id',
      displayName: 'me@example.test',
    });
    expect(done.refreshToken).toBe('placeholder-refresh');
    expect(done.expiresAt).toBe(1_000 + 3_600_000);
    expect(done.scopes).toEqual(['Calendars.Read', 'User.Read', 'email', 'openid', 'profile']);
    const [tokenUrl, init] = fetch.mock.calls[0]! as [string, { body: string; redirect: string }];
    expect(tokenUrl).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/token');
    expect(init.redirect).toBe('error');
    const body = new URLSearchParams(init.body);
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('code_verifier')).toBeTruthy();
    expect(fetch.mock.calls[1]![0]).toContain(`${MICROSOFT_GRAPH_API}/me?`);
  });

  it('accepts resource-qualified Graph scopes', async () => {
    const { p } = provider([
      tokenRes({
        scope:
          'https://graph.microsoft.com/Calendars.Read https://graph.microsoft.com/User.Read openid',
      }),
      meRes,
    ]);
    await expect(connect(p)).resolves.toBeTruthy();
  });

  it('binds state to org and user and makes it single use', async () => {
    const { p } = provider([tokenRes(), meRes]);
    const { state } = await p.beginAuthorization({
      organizationId: ORG,
      userId: USER,
      redirectUri: REDIRECT,
    });
    const args = { state, code: 'c', userId: USER, redirectUri: REDIRECT };
    await expect(p.completeAuthorization({ ...args, organizationId: OTHER_ORG })).rejects.toThrow();
    await expect(p.completeAuthorization({ ...args, organizationId: ORG })).rejects.toThrow();
  });

  it('rejects insufficient scopes, write scopes, and missing refresh tokens', async () => {
    for (const [over, code] of [
      [{ scope: 'User.Read' }, 'insufficient_scope'],
      [{ scope: `${SCOPE} Calendars.ReadWrite` }, 'excess_scope'],
      [{ scope: `${SCOPE} Mail.Read` }, 'excess_scope'],
      [{ refresh_token: undefined }, 'missing_refresh_token'],
    ] as const) {
      const { p } = provider([tokenRes(over), meRes]);
      await expect(connect(p)).rejects.toMatchObject({ code });
    }
  });

  it('refresh stores the rotated token and keeps the old one when omitted', async () => {
    const { p, fetch } = provider([
      tokenRes({ refresh_token: 'rotated' }),
      tokenRes({ refresh_token: undefined, scope: undefined }),
    ]);
    expect((await p.refresh('old')).refreshToken).toBe('rotated');
    expect((await p.refresh('old')).refreshToken).toBe('old');
    const body = new URLSearchParams((fetch.mock.calls[0]![1] as { body: string }).body);
    expect(body.get('grant_type')).toBe('refresh_token');
    expect(body.get('scope')).toContain('Calendars.Read');
  });

  it('maps token-endpoint invalid_grant', async () => {
    const { p } = provider([
      { status: 400, body: { error: 'invalid_grant', error_description: 'x' } },
    ]);
    await expect(p.refresh('old')).rejects.toMatchObject({ code: 'invalid_grant', status: 400 });
  });

  it('maps calendarView events to the common model and follows Graph nextLinks only', async () => {
    const next = `${MICROSOFT_GRAPH_API}/me/calendarView?$skip=1`;
    const { p, fetch } = provider([
      {
        status: 200,
        body: {
          value: [
            ev(),
            ev({ id: '' }),
            ev({ id: 'e2', start: { dateTime: 'bad', timeZone: 'UTC' } }),
            ev({
              id: 'e3',
              start: { dateTime: '2026-11-02T10:00:00', timeZone: 'Pacific Standard Time' },
            }),
          ],
          '@odata.nextLink': next,
        },
      },
      {
        status: 200,
        body: {
          value: [
            ev({
              id: 'e4',
              isAllDay: true,
              start: { dateTime: '2026-11-03T00:00:00.0000000', timeZone: 'UTC' },
              end: { dateTime: '2026-11-04T00:00:00.0000000', timeZone: 'UTC' },
              showAs: 'tentative',
              webLink: 'https://evil.test/x',
              onlineMeeting: { joinUrl: 'https://evil.test/join' },
              onlineMeetingUrl: null,
              subject: '  ',
              attendees: undefined,
            }),
          ],
          '@odata.nextLink': 'https://evil.test/v1.0/me/calendarView',
        },
      },
    ]);
    const list = await p.listEvents({ accessToken: 'at', ...WIN });
    expect(list).toEqual([
      {
        id: 'e1',
        title: 'Standup',
        startsAt: '2026-11-02T10:00:00.000Z',
        endsAt: '2026-11-02T10:30:00.000Z',
        allDay: false,
        attendeeCount: 2,
        status: 'confirmed',
        conferenceUrl: 'https://teams.microsoft.com/l/meetup-join/abc',
        htmlLink: 'https://outlook.office365.com/owa/?itemid=1',
        organizerEmail: 'boss@example.test',
      },
      {
        id: 'e4',
        title: '(no title)',
        startsAt: '2026-11-03T00:00:00.000Z',
        endsAt: '2026-11-04T00:00:00.000Z',
        allDay: true,
        attendeeCount: 0,
        status: 'tentative',
        organizerEmail: 'boss@example.test',
      },
    ]);
    expect(fetch).toHaveBeenCalledTimes(2);
    const [url, init] = fetch.mock.calls[0]! as [string, { headers: Record<string, string> }];
    const u = new URL(url);
    expect(u.pathname).toBe('/v1.0/me/calendarView');
    expect(u.searchParams.get('startDateTime')).toBe('2026-11-01T00:00:00.000Z');
    expect(init.headers.Authorization).toBe('Bearer at');
    expect(init.headers.Prefer).toContain('outlook.timezone="UTC"');
    expect(fetch.mock.calls[1]![0]).toBe(next);
  });

  it('caps results at maxResults and marks cancelled events', async () => {
    const { p } = provider([
      { status: 200, body: { value: [ev({ isCancelled: true }), ev({ id: 'e2' })] } },
    ]);
    const list = await p.listEvents({ accessToken: 'at', ...WIN, maxResults: 1 });
    expect(list).toHaveLength(1);
    expect(list[0]!.status).toBe('cancelled');
  });

  it('rejects inverted windows before calling Graph', async () => {
    const { p, fetch } = provider([]);
    await expect(
      p.listEvents({ accessToken: 'at', timeMin: WIN.timeMax, timeMax: WIN.timeMin }),
    ).rejects.toBeInstanceOf(CalendarProviderError);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('maps Graph errors: throttling, auth, sanitized bodies', async () => {
    const { p } = provider([
      { status: 429, body: { error: { code: 'TooManyRequests', message: 'secret detail' } } },
      { status: 401, body: { error: { code: 'InvalidAuthenticationToken', message: 'x' } } },
      { status: 503, body: { error: { code: 'ApplicationThrottled' } } },
    ]);
    const e1 = await p.listEvents({ accessToken: 'at', ...WIN }).catch((e: unknown) => e);
    expect(e1).toMatchObject({ code: 'rate_limited', status: 429 });
    expect(String((e1 as Error).message)).not.toContain('secret detail');
    await expect(p.listEvents({ accessToken: 'at', ...WIN })).rejects.toMatchObject({
      code: 'http_error',
      status: 401,
    });
    await expect(p.listEvents({ accessToken: 'at', ...WIN })).rejects.toMatchObject({
      code: 'rate_limited',
    });
    expect(graphApiErrorCode({ error: { code: 'syncStateNotFound' } }, 410)).toBe(
      'sync_state_expired',
    );
    expect(graphApiErrorCode(undefined, 500)).toBe('http_error');
  });

  it('delta: walks nextLinks to the deltaLink and reports removals', async () => {
    const delta = `${MICROSOFT_GRAPH_API}/me/calendarView/delta?$deltatoken=t1`;
    const { p, fetch } = provider([
      {
        status: 200,
        body: {
          value: [ev()],
          '@odata.nextLink': `${MICROSOFT_GRAPH_API}/me/calendarView/delta?$skiptoken=s1`,
        },
      },
      {
        status: 200,
        body: {
          value: [{ id: 'gone', '@removed': { reason: 'deleted' } }],
          '@odata.deltaLink': delta,
        },
      },
    ]);
    const r = await p.listEventsDelta({ accessToken: 'at', ...WIN });
    expect(r.events.map((e) => e.id)).toEqual(['e1']);
    expect(r.removedIds).toEqual(['gone']);
    expect(r.deltaLink).toBe(delta);
    expect(new URL(fetch.mock.calls[0]![0]).pathname).toBe('/v1.0/me/calendarView/delta');
  });

  it('delta: resumes from a deltaLink, refuses foreign links, maps expired cursors', async () => {
    const { p, fetch } = provider([
      { status: 410, body: { error: { code: 'syncStateNotFound' } } },
    ]);
    await expect(
      p.listEventsDelta({
        accessToken: 'at',
        deltaLink: 'https://evil.test/v1.0/me/calendarView/delta',
      }),
    ).rejects.toMatchObject({ code: 'invalid_delta_link' });
    expect(fetch).not.toHaveBeenCalled();
    await expect(
      p.listEventsDelta({
        accessToken: 'at',
        deltaLink: `${MICROSOFT_GRAPH_API}/me/calendarView/delta?$deltatoken=old`,
      }),
    ).rejects.toMatchObject({ code: 'sync_state_expired' });
  });

  it('revoke is a documented no-op (no Microsoft per-token revocation endpoint)', async () => {
    const { p, fetch } = provider([]);
    await expect(p.revoke('t')).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('times out a stalled request', async () => {
    const fetch = vi.fn(() => new Promise<never>(() => {}));
    const p = new OutlookCalendarProvider({
      clientId: 'cid',
      clientSecret: async () => 's',
      redirectUriAllowlist: [REDIRECT],
      stateStore: new InMemoryOAuthStateStore(),
      fetch,
      timeoutMs: 20,
    });
    await expect(p.listEvents({ accessToken: 'at', ...WIN })).rejects.toMatchObject({
      code: 'timeout',
    });
  });

  it('mapOutlookEvent falls back to onlineMeetingUrl and exposes the read-only scopes', () => {
    expect(
      mapOutlookEvent(ev({ onlineMeeting: null, onlineMeetingUrl: 'https://zoom.us/j/1' }))
        ?.conferenceUrl,
    ).toBe('https://zoom.us/j/1');
    expect(mapOutlookEvent(null)).toBeNull();
    expect([...OUTLOOK_CALENDAR_SCOPES]).toEqual(['Calendars.Read', 'User.Read']);
  });
});
