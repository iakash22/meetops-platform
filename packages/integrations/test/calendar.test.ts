import { describe, it, expect, vi } from 'vitest';
import {
  CalendarProviderError,
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_TOKEN_URL,
  GoogleCalendarProvider,
  InMemoryOAuthStateStore,
  assertCalendarWindow,
} from '../src/index.js';
import { ORG, OTHER_ORG } from './helpers.js';

const REDIRECT = 'https://api.meetops.test/calendar/google/callback';
const USER = 'user-1';
const SCOPE = GOOGLE_CALENDAR_SCOPES.join(' ');

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
const calRes: Res = { status: 200, body: { id: 'me@example.test', summary: 'Me' } };

function provider(queue: Res[]) {
  const fetch = fetchMock(queue);
  const p = new GoogleCalendarProvider({
    clientId: 'cid',
    clientSecret: async () => 'placeholder-secret',
    redirectUriAllowlist: [REDIRECT],
    stateStore: new InMemoryOAuthStateStore(),
    fetch: fetch,
    now: () => 1_000,
  });
  return { p, fetch };
}

describe('GoogleCalendarProvider', () => {
  it('builds a PKCE consent URL on the fixed Google endpoint with read-only scopes', async () => {
    const { p } = provider([]);
    const { url, state } = await p.beginAuthorization({
      organizationId: ORG,
      userId: USER,
      redirectUri: REDIRECT,
    });
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe(GOOGLE_AUTHORIZE_URL);
    expect(u.searchParams.get('scope')).toBe(SCOPE);
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('access_type')).toBe('offline');
    expect(u.searchParams.get('state')).toBe(state);
    expect(url).not.toContain('placeholder-secret');
  });

  it('rejects redirect URIs outside the allowlist', async () => {
    const { p } = provider([]);
    await expect(
      p.beginAuthorization({
        organizationId: ORG,
        userId: USER,
        redirectUri: 'https://evil.test/cb',
      }),
    ).rejects.toThrow();
  });

  it('exchanges the code with the verifier and returns the primary calendar account', async () => {
    const { p, fetch } = provider([tokenRes(), calRes]);
    const { state } = await p.beginAuthorization({
      organizationId: ORG,
      userId: USER,
      redirectUri: REDIRECT,
    });
    const r = await p.completeAuthorization({
      state,
      code: 'auth-code',
      organizationId: ORG,
      userId: USER,
      redirectUri: REDIRECT,
    });
    expect(r.account).toEqual({ externalAccountId: 'me@example.test', displayName: 'Me' });
    expect(r.expiresAt).toBe(1_000 + 3_600_000);
    expect(fetch.mock.calls[0]![0]).toBe(GOOGLE_TOKEN_URL);
    const body = new URLSearchParams(String((fetch.mock.calls[0]![1] as { body: string }).body));
    expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((fetch.mock.calls[0]![1] as { redirect: string }).redirect).toBe('error');
  });

  it('binds state to the organization and user and makes it single use', async () => {
    const { p } = provider([tokenRes(), calRes]);
    const { state } = await p.beginAuthorization({
      organizationId: ORG,
      userId: USER,
      redirectUri: REDIRECT,
    });
    await expect(
      p.completeAuthorization({
        state,
        code: 'c',
        organizationId: OTHER_ORG,
        userId: USER,
        redirectUri: REDIRECT,
      }),
    ).rejects.toThrow();
    await expect(
      p.completeAuthorization({
        state,
        code: 'c',
        organizationId: ORG,
        userId: USER,
        redirectUri: REDIRECT,
      }),
    ).rejects.toThrow();
  });

  it('rejects insufficient scopes and missing refresh tokens', async () => {
    const a = provider([tokenRes({ scope: GOOGLE_CALENDAR_SCOPES[0] })]);
    const s1 = (
      await a.p.beginAuthorization({ organizationId: ORG, userId: USER, redirectUri: REDIRECT })
    ).state;
    await expect(
      a.p.completeAuthorization({
        state: s1,
        code: 'c',
        organizationId: ORG,
        userId: USER,
        redirectUri: REDIRECT,
      }),
    ).rejects.toThrow(/insufficient_scope/);
    const b = provider([tokenRes({ refresh_token: undefined })]);
    const s2 = (
      await b.p.beginAuthorization({ organizationId: ORG, userId: USER, redirectUri: REDIRECT })
    ).state;
    await expect(
      b.p.completeAuthorization({
        state: s2,
        code: 'c',
        organizationId: ORG,
        userId: USER,
        redirectUri: REDIRECT,
      }),
    ).rejects.toThrow(/missing_refresh_token/);
  });

  it('refresh keeps the old refresh token when Google omits it', async () => {
    const { p } = provider([tokenRes({ refresh_token: undefined, access_token: 'new-access' })]);
    const t = await p.refresh('old-refresh');
    expect(t).toMatchObject({ accessToken: 'new-access', refreshToken: 'old-refresh' });
  });

  it('maps events, drops malformed ones and non-https links', async () => {
    const { p, fetch } = provider([
      {
        status: 200,
        body: {
          items: [
            {
              id: 'e1',
              summary: 'Standup',
              start: { dateTime: '2026-11-02T04:30:00Z' },
              end: { dateTime: '2026-11-02T05:00:00Z' },
              hangoutLink: 'https://meet.google.com/abc-defg-hij',
              htmlLink: 'https://calendar.google.com/e1',
              attendees: [{}, {}],
              organizer: { email: 'o@example.test' },
            },
            {
              id: 'e2',
              start: { date: '2026-11-03' },
              end: { date: '2026-11-04' },
              hangoutLink: 'javascript:alert(1)',
              status: 'tentative',
            },
            { id: 'bad', start: {}, end: {} },
            { summary: 'no id' },
          ],
        },
      },
    ]);
    const ev = await p.listEvents({
      accessToken: 'a',
      timeMin: '2026-11-01T00:00:00Z',
      timeMax: '2026-11-08T00:00:00Z',
    });
    expect(ev).toHaveLength(2);
    expect(ev[0]).toMatchObject({
      id: 'e1',
      title: 'Standup',
      conferenceUrl: 'https://meet.google.com/abc-defg-hij',
      attendeeCount: 2,
      allDay: false,
    });
    expect(ev[1]).toMatchObject({
      id: 'e2',
      title: '(no title)',
      allDay: true,
      status: 'tentative',
      startsAt: '2026-11-03T00:00:00.000Z',
    });
    expect(ev[1]!.conferenceUrl).toBeUndefined();
    const url = new URL(String(fetch.mock.calls[0]![0]));
    expect(url.origin).toBe('https://www.googleapis.com');
    expect(url.searchParams.get('singleEvents')).toBe('true');
  });

  it('sanitizes upstream errors', async () => {
    const { p } = provider([
      { status: 401, body: { error: 'invalid_grant', error_description: 'secret detail' } },
    ]);
    const err = await p.refresh('r').catch((e: unknown) => e as CalendarProviderError);
    expect(err).toBeInstanceOf(CalendarProviderError);
    expect(err.message).not.toContain('secret detail');
    expect(err.code).toBe('invalid_grant');
  });
});

describe('assertCalendarWindow', () => {
  it('rejects inverted, invalid and oversized windows', () => {
    expect(() => assertCalendarWindow('2026-11-02', '2026-11-01')).toThrow(/invalid_window/);
    expect(() => assertCalendarWindow('x', '2026-11-01')).toThrow(/invalid_window/);
    expect(() => assertCalendarWindow('2026-01-01', '2026-06-01')).toThrow(/window_too_large/);
    expect(assertCalendarWindow('2026-11-01', '2026-11-08').min.toISOString()).toBe(
      '2026-11-01T00:00:00.000Z',
    );
  });
});
