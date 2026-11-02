import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { CalendarEventList, CalendarProviderList } from '@meetops/contracts';
import { GOOGLE_CALENDAR_SCOPES } from '@meetops/integrations';
import { InMemoryAuditLog } from '../src/modules/auth/domain/audit.js';
import { InMemoryCalendarConnections } from '../src/modules/calendar/in-memory.repository.js';
import type { SyncedCalendarStore } from '../src/modules/calendar/ports.js';
import { selectCalendarSyncStore } from '../src/modules/calendar/index.js';
import {
  devIntegrationsRuntime,
  integrationsRuntimeFromEnv,
} from '../src/modules/integrations/runtime.js';
import type { ModuleDeps } from '../src/modules/index.js';
import { buildApp, signupAndLogin, type App, type Client } from './helpers.js';

const API = 'http://localhost:4000';
const SCOPE = GOOGLE_CALENDAR_SCOPES.join(' ');
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

type Call = { url: string; method: string; body?: string; auth?: string };

describe('Phase 7 calendar', () => {
  let app: App;
  let repo: InMemoryCalendarConnections;
  let audit: InMemoryAuditLog;
  let calls: Call[];
  let over: Record<string, () => Response>;
  let now: number;

  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input.toString();
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method,
      ...(typeof init?.body === 'string' ? { body: init.body } : {}),
      ...(headers.Authorization ? { auth: headers.Authorization } : {}),
    });
    const key = `${method} ${url.split('?')[0]}`;
    if (over[key]) return over[key]();
    switch (key) {
      case 'POST https://oauth2.googleapis.com/token':
        return json({
          access_token: `g-access-${calls.length}`,
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
              hangoutLink: 'https://meet.google.com/abc-defg-hij',
            },
          ],
        });
      default:
        return json({ error: 'unexpected' }, 500);
    }
  };

  async function build(withGoogle = true, calendarSyncStore?: SyncedCalendarStore) {
    app = await buildApp({
      calendarConnections: repo,
      ...(calendarSyncStore ? { calendarSyncStore } : {}),
      audit,
      integrationsRuntime: devIntegrationsRuntime({
        apiOrigin: API,
        fetch: fetchFn,
        now: () => now,
        ...(withGoogle
          ? { googleCalendar: { clientId: 'gcal-client', clientSecret: async () => 'gcal-secret' } }
          : {}),
      }),
    } as Partial<ModuleDeps>);
  }

  beforeEach(async () => {
    repo = new InMemoryCalendarConnections();
    audit = new InMemoryAuditLog();
    calls = [];
    over = {};
    now = Date.now();
    await build();
  });
  afterEach(async () => app.close());

  const createOrg = async (c: Client, name: string) =>
    (await c.post('/orgs', { name })).json<{ organization: { id: string } }>().organization.id;
  const connect = async (c: Client, org: string) => {
    const res = await c.post(`/orgs/${org}/calendar/connect`, {
      provider: 'google',
      returnTo: '/calendar',
    });
    expect(res.statusCode).toBe(200);
    return new URL(res.json<{ authorizeUrl: string }>().authorizeUrl);
  };

  it('connect -> callback stores encrypted-at-rest tokens server-side, audits, and is single-use', async () => {
    const c = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(c, 'Acme');
    const url = await connect(c, org);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('redirect_uri')).toBe(`${API}/calendar/google/callback`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const state = url.searchParams.get('state')!;

    const cb = await c.get(`/calendar/google/callback?state=${state}&code=abc`);
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe(
      'http://localhost:3000/calendar?calendar=google&status=connected',
    );
    const row = [...repo.rows.values()][0]!;
    expect(row).toMatchObject({ provider: 'google', externalAccountId: 'me@example.test' });
    expect(audit.events.some((e) => e.action === 'calendar.connect')).toBe(true);
    expect(JSON.stringify(audit.events)).not.toMatch(/g-access|g-refresh|gcal-secret/);
    expect((await c.get(`/calendar/google/callback?state=${state}&code=abc`)).statusCode).toBe(400);

    const providers = await c.get(`/orgs/${org}/calendar/providers`);
    expect(Value.Check(CalendarProviderList, providers.json())).toBe(true);
    expect(providers.body).not.toMatch(/g-access|g-refresh/);
    expect(providers.json<CalendarProviderList>().items[0]).toMatchObject({
      configured: true,
      connection: { status: 'active' },
    });
  });

  it('lists events, refreshing an expiring token first', async () => {
    const c = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(c, 'Acme');
    const state = (await connect(c, org)).searchParams.get('state')!;
    await c.get(`/calendar/google/callback?state=${state}&code=abc`);
    now += 3600_000; // token now expired
    calls = [];
    const res = await c.get(
      `/orgs/${org}/calendar/events?from=2026-11-01T00:00:00.000Z&to=2026-11-08T00:00:00.000Z`,
    );
    expect(res.statusCode).toBe(200);
    expect(Value.Check(CalendarEventList, res.json())).toBe(true);
    expect(res.json<CalendarEventList>().items[0]).toMatchObject({
      id: 'ev1',
      title: 'Weekly sync',
      provider: 'google',
    });
    expect(calls[0]!.url).toBe('https://oauth2.googleapis.com/token');
    expect(calls[1]!.auth).toBe(`Bearer g-access-1`);
    expect(res.headers['cache-control']).toBe('private, no-store');
  });

  describe('P7 read-through of worker-synced events', () => {
    const FROM = '2026-11-01T00:00:00.000Z';
    const TO = '2026-11-08T00:00:00.000Z';
    const stored = {
      id: 'stored-1',
      connectionId: 'ignored',
      title: 'From sync',
      startsAt: '2026-11-03T09:00:00.000Z',
      endsAt: '2026-11-03T09:30:00.000Z',
      allDay: false,
      attendeeCount: 2,
      status: 'confirmed' as const,
    };
    function store(cov: { from: string; to: string; ageMs: number } | 'throw' | null) {
      const seen: { org: string; user: string }[] = [];
      const s: SyncedCalendarStore = {
        coverage: async (org, user) => {
          seen.push({ org, user });
          if (cov === 'throw') throw new Error('db down');
          return cov
            ? {
                from: new Date(cov.from),
                to: new Date(cov.to),
                lastSyncedAt: new Date(now - cov.ageMs),
              }
            : null;
        },
        listEvents: async () => [stored],
      };
      return { s, seen };
    }
    async function setup(cov: Parameters<typeof store>[0]) {
      await app.close();
      const st = store(cov);
      await build(true, st.s);
      const c = await signupAndLogin(app, 'owner@example.com');
      const org = await createOrg(c, 'Acme');
      const state = (await connect(c, org)).searchParams.get('state')!;
      await c.get(`/calendar/google/callback?state=${state}&code=abc`);
      calls = [];
      const res = await c.get(`/orgs/${org}/calendar/events?from=${FROM}&to=${TO}`);
      expect(res.statusCode).toBe(200);
      expect(Value.Check(CalendarEventList, res.json())).toBe(true);
      return { res: res.json<CalendarEventList>(), seen: st.seen, org };
    }
    const liveCalls = () => calls.filter((x) => x.url.includes('/calendars/primary/events'));

    it('serves fresh, fully covering synced events without calling Google, scoped to the caller', async () => {
      const { res, seen, org } = await setup({
        from: '2026-10-31T00:00:00Z',
        to: '2026-11-30T00:00:00Z',
        ageMs: 60_000,
      });
      expect(res.items).toHaveLength(1);
      expect(res.items[0]).toMatchObject({
        id: 'stored-1',
        title: 'From sync',
        provider: 'google',
      });
      expect(res.items[0]!.connectionId).toBe([...repo.rows.values()][0]!.id);
      expect(liveCalls()).toHaveLength(0);
      expect(seen[0]!.org).toBe(org);
    });

    it('falls back to a live read when the sync is stale', async () => {
      const { res } = await setup({
        from: '2026-10-31T00:00:00Z',
        to: '2026-11-30T00:00:00Z',
        ageMs: 31 * 60_000,
      });
      expect(res.items[0]!.id).toBe('ev1');
      expect(liveCalls()).toHaveLength(1);
    });

    it('falls back to a live read when the window is not fully covered', async () => {
      const { res } = await setup({
        from: '2026-11-02T00:00:00Z',
        to: '2026-11-30T00:00:00Z',
        ageMs: 0,
      });
      expect(res.items[0]!.id).toBe('ev1');
    });

    it('falls back to a live read when never synced or the store fails', async () => {
      expect((await setup(null)).res.items[0]!.id).toBe('ev1');
      expect((await setup('throw')).res.items[0]!.id).toBe('ev1');
    });

    it('is off by default: no store without CALENDAR_SYNC_ENABLED=true and a database', () => {
      expect(selectCalendarSyncStore({} as never, {})).toBeUndefined();
      expect(
        selectCalendarSyncStore({} as never, { CALENDAR_SYNC_ENABLED: 'true' }),
      ).toBeUndefined();
      expect(
        selectCalendarSyncStore({ db: {} } as never, { CALENDAR_SYNC_ENABLED: 'false' }),
      ).toBeUndefined();
      expect(
        selectCalendarSyncStore({ db: {} } as never, { CALENDAR_SYNC_ENABLED: 'true' }),
      ).toBeDefined();
    });
  });

  it('rejects oversized windows and marks a connection error on upstream 401', async () => {
    const c = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(c, 'Acme');
    const state = (await connect(c, org)).searchParams.get('state')!;
    await c.get(`/calendar/google/callback?state=${state}&code=abc`);
    expect(
      (
        await c.get(
          `/orgs/${org}/calendar/events?from=2026-01-01T00:00:00.000Z&to=2026-06-01T00:00:00.000Z`,
        )
      ).statusCode,
    ).toBe(400);
    over['GET https://www.googleapis.com/calendar/v3/calendars/primary/events'] = () =>
      json({ error: { code: 401 } }, 401);
    const res = await c.get(
      `/orgs/${org}/calendar/events?from=2026-11-01T00:00:00.000Z&to=2026-11-08T00:00:00.000Z`,
    );
    expect(res.json()).toEqual({ items: [] });
    expect([...repo.rows.values()][0]!.status).toBe('error');
  });

  it('is per user: another member cannot see or disconnect my connection; disconnect wipes tokens', async () => {
    const c = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(c, 'Acme');
    const state = (await connect(c, org)).searchParams.get('state')!;
    await c.get(`/calendar/google/callback?state=${state}&code=abc`);
    const id = [...repo.rows.values()][0]!.id;

    const other = await signupAndLogin(app, 'other@example.com');
    const otherOrg = await createOrg(other, 'Other');
    expect((await other.delete(`/orgs/${org}/calendar/connections/${id}`)).statusCode).toBe(404);
    expect((await other.delete(`/orgs/${otherOrg}/calendar/connections/${id}`)).statusCode).toBe(
      404,
    );
    expect(
      (await other.get(`/orgs/${otherOrg}/calendar/providers`)).json<CalendarProviderList>()
        .items[0]!.connection,
    ).toBeUndefined();

    calls = [];
    expect((await c.delete(`/orgs/${org}/calendar/connections/${id}`)).statusCode).toBe(204);
    expect(calls.map((x) => x.url)).toEqual(['https://oauth2.googleapis.com/revoke']);
    expect(calls[0]!.body).toBe('token=g-refresh');
    expect(repo.secrets.has(id)).toBe(false);
    expect([...repo.rows.values()][0]!.status).toBe('revoked');
  });

  it('an over-scoped grant is a 400 (not 502), stores nothing, and is revoked at Google', async () => {
    const c = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(c, 'Acme');
    const state = (await connect(c, org)).searchParams.get('state')!;
    over['POST https://oauth2.googleapis.com/token'] = () =>
      json({
        access_token: 'g-access-x',
        refresh_token: 'g-refresh-x',
        expires_in: 3600,
        token_type: 'Bearer',
        scope: `${SCOPE} https://www.googleapis.com/auth/calendar`,
      });
    const res = await c.get(`/calendar/google/callback?state=${state}&code=abc`);
    expect(res.statusCode).toBe(400);
    expect(repo.rows.size).toBe(0);
    const revoke = calls.find((x) => x.url === 'https://oauth2.googleapis.com/revoke');
    expect(revoke?.body).toBe('token=g-refresh-x');
  });

  it('L-1: disconnect still wipes locally when the provider revoke fails', async () => {
    const c = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(c, 'Acme');
    const state = (await connect(c, org)).searchParams.get('state')!;
    await c.get(`/calendar/google/callback?state=${state}&code=abc`);
    const id = [...repo.rows.values()][0]!.id;
    over['POST https://oauth2.googleapis.com/revoke'] = () => json({ error: 'invalid_token' }, 400);
    expect((await c.delete(`/orgs/${org}/calendar/connections/${id}`)).statusCode).toBe(204);
    expect(repo.secrets.has(id)).toBe(false);
    expect([...repo.rows.values()][0]!.status).toBe('revoked');
    expect(audit.events.find((e) => e.action === 'calendar.disconnect')!.metadata).toMatchObject({
      providerRevoked: 'false',
    });
  });

  it('answers 503 when the Google OAuth client is not configured, and never accepts an endpoint', async () => {
    await app.close();
    await build(false);
    const c = await signupAndLogin(app, 'owner@example.com');
    const org = await createOrg(c, 'Acme');
    expect((await c.post(`/orgs/${org}/calendar/connect`, { provider: 'google' })).statusCode).toBe(
      503,
    );
    expect(
      (
        await c.post(`/orgs/${org}/calendar/connect`, {
          provider: 'google',
          endpoint: 'https://evil.test',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await c.post(`/orgs/${org}/calendar/connect`, { provider: 'outlook' })).statusCode,
    ).toBe(503);
    expect((await c.post(`/orgs/${org}/calendar/connect`, { provider: 'yahoo' })).statusCode).toBe(
      400,
    );
    expect(
      (await c.get(`/orgs/${org}/calendar/providers`)).json<CalendarProviderList>().items[0]!
        .configured,
    ).toBe(false);
  });

  it('reads the Outlook OAuth client and tenant from env only when both values are set', async () => {
    expect(integrationsRuntimeFromEnv({ OUTLOOK_CALENDAR_CLIENT_ID: 'x' }).outlookCalendar).toBe(
      undefined,
    );
    const rt = integrationsRuntimeFromEnv({
      OUTLOOK_CALENDAR_CLIENT_ID: 'id',
      OUTLOOK_CALENDAR_CLIENT_SECRET: 'placeholder',
      OUTLOOK_CALENDAR_TENANT: 'organizations',
    }).outlookCalendar;
    expect(rt?.clientId).toBe('id');
    expect(rt?.tenant).toBe('organizations');
    expect(await rt?.clientSecret()).toBe('placeholder');
  });

  it('reads the Google OAuth client from env only when both values are set', () => {
    expect(integrationsRuntimeFromEnv({ GOOGLE_CALENDAR_CLIENT_ID: 'x' }).googleCalendar).toBe(
      undefined,
    );
    expect(
      integrationsRuntimeFromEnv({
        GOOGLE_CALENDAR_CLIENT_ID: 'x',
        GOOGLE_CALENDAR_CLIENT_SECRET: 'y',
      }).googleCalendar?.clientId,
    ).toBe('x');
  });
});

describe('OUTLOOK_CALENDAR_TENANT startup validation', () => {
  const base = { OUTLOOK_CALENDAR_CLIENT_ID: 'id', OUTLOOK_CALENDAR_CLIENT_SECRET: 'placeholder' };

  it.each([
    'common',
    'organizations',
    'consumers',
    '72f988bf-86f1-41af-91ab-2d7cd011db47',
    'contoso.onmicrosoft.com',
  ])('accepts %s', (t) => {
    expect(
      integrationsRuntimeFromEnv({ ...base, OUTLOOK_CALENDAR_TENANT: ` ${t} ` }).outlookCalendar
        ?.tenant,
    ).toBe(t);
  });

  it('unset or blank keeps the provider default', () => {
    expect(integrationsRuntimeFromEnv(base).outlookCalendar?.tenant).toBeUndefined();
    expect(
      integrationsRuntimeFromEnv({ ...base, OUTLOOK_CALENDAR_TENANT: ' ' }).outlookCalendar?.tenant,
    ).toBeUndefined();
  });

  it('fails fast on a malformed tenant, even with no Outlook client configured', () => {
    for (const env of [
      { ...base, OUTLOOK_CALENDAR_TENANT: 'contoso' },
      { OUTLOOK_CALENDAR_TENANT: 'common/../x' },
    ])
      expect(() => integrationsRuntimeFromEnv(env)).toThrow(
        /OUTLOOK_CALENDAR_TENANT must be common, organizations, consumers, a tenant GUID/,
      );
  });
});
