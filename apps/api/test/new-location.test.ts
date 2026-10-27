import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { Value } from '@sinclair/typebox/value';
import { AuthNewLocationSigninEvent } from '@meetops/contracts';
import { EMPTY_GEO, MmdbGeoIpProvider, type GeoFields } from '../src/shared/geoip/index.js';
import { InMemorySessionRepository } from '../src/modules/auth/infrastructure/in-memory-session.repository.js';
import {
  buildNewLocationEvent,
  newLocationReason,
} from '../src/modules/auth/application/new-location.js';
import { buildApp, Client, signupAndLogin, PASSWORD, type App } from './helpers.js';

const FIXTURE = fileURLToPath(new URL('./fixtures/geoip/test-city.mmdb', import.meta.url));
const LONDON = '81.2.69.142';
const SWEDEN = '89.160.20.112';
const CHINA = '175.16.199.1';
const geo = (cc: string | null, region: string | null): GeoFields => ({
  ...EMPTY_GEO,
  geoCountryCode: cc,
  geoRegion: region,
  geoApproximate: cc ? true : null,
});

describe('newLocationReason (ADR-014)', () => {
  it('first sign-in (no history) is the baseline: no alert', () => {
    expect(newLocationReason(geo('GB', 'England'), [])).toBeNull();
  });
  it('unknown/private location never alerts', () => {
    expect(newLocationReason(EMPTY_GEO, [{ countryCode: 'GB', region: 'England' }])).toBeNull();
  });
  it('new country alerts, same country and region do not', () => {
    const h = [{ countryCode: 'GB', region: 'England' }];
    expect(newLocationReason(geo('SE', null), h)).toBe('new_country');
    expect(newLocationReason(geo('GB', 'England'), h)).toBeNull();
    expect(newLocationReason(geo('GB', null), h)).toBeNull();
  });
  it('new region in a known country alerts; missing region data never does', () => {
    expect(
      newLocationReason(geo('GB', 'Scotland'), [{ countryCode: 'GB', region: 'England' }]),
    ).toBe('new_region');
    expect(
      newLocationReason(geo('GB', 'Scotland'), [{ countryCode: 'GB', region: null }]),
    ).toBeNull();
  });
});

describe('buildNewLocationEvent payload strictness', () => {
  const base = {
    organizationId: '00000000-0000-4000-8000-000000000001',
    userId: '00000000-0000-4000-8000-000000000002',
    sessionId: '00000000-0000-4000-8000-000000000003',
    reason: 'new_country' as const,
  };
  it('has exactly the contract keys and no IP', () => {
    const e = buildNewLocationEvent({
      ...base,
      geo: {
        geoCity: 'London',
        geoRegion: 'England',
        geoCountry: 'United Kingdom',
        geoCountryCode: 'GB',
        geoApproximate: true,
      },
    });
    expect(Object.keys(e.payload).sort()).toEqual(
      ['city', 'country', 'countryCode', 'reason', 'region', 'sessionId'].sort(),
    );
    expect(Value.Check(AuthNewLocationSigninEvent, e.payload)).toBe(true);
    expect(JSON.stringify(e)).not.toMatch(/\bip\b|ipAddress|\d+\.\d+\.\d+\.\d+/i);
  });
  it('rejects geo text that the contract forbids (e.g. IP-like or CR/LF) instead of shipping it', () => {
    expect(() =>
      buildNewLocationEvent({ ...base, geo: { ...geo('GB', null), geoCity: '81.2.69.142' } }),
    ).toThrow();
    expect(() =>
      buildNewLocationEvent({ ...base, geo: { ...geo('GB', null), geoCity: 'Pune\r\nBcc: x' } }),
    ).toThrow();
  });
  it('the contract refuses an extra ip key', () => {
    const e = buildNewLocationEvent({ ...base, geo: geo('SE', null) });
    expect(Value.Check(AuthNewLocationSigninEvent, { ...e.payload, ip: '89.160.20.112' })).toBe(
      false,
    );
  });
});

describe('sign-in flow writes auth.new_location_signin (in-memory)', () => {
  let app: App;
  let sessions: InMemorySessionRepository;
  let peer = LONDON;
  beforeEach(async () => {
    sessions = new InMemorySessionRepository();
    app = await buildApp({ sessions, geoIp: new MmdbGeoIpProvider(FIXTURE) });
    const inject = app.inject.bind(app) as (o: object) => ReturnType<App['inject']>;
    (app as unknown as { inject: (o: object) => unknown }).inject = (o: object) =>
      inject({ ...o, remoteAddress: peer });
  });
  afterEach(async () => {
    peer = LONDON;
    await app.close();
  });

  const login = async (email: string) => {
    const c = new Client(app);
    const r = await c.post('/auth/login', { email, password: PASSWORD });
    expect(r.statusCode).toBe(200);
    return c;
  };
  /** Signed-in user with an org (outbox events are org-scoped). */
  const userWithOrg = async (email: string) => {
    const c = await signupAndLogin(app, email);
    expect((await c.post('/orgs', { name: 'Geo Org' })).statusCode).toBe(201);
    return c;
  };

  it('baseline sign-in: no alert; same country: no alert; new country: one alert without IP', async () => {
    await userWithOrg('a@example.com');
    expect(sessions.outbox).toHaveLength(0);
    await login('a@example.com');
    expect(sessions.outbox).toHaveLength(0);
    peer = SWEDEN;
    await login('a@example.com');
    expect(sessions.outbox).toHaveLength(1);
    const e = sessions.outbox[0]!;
    expect(e).toMatchObject({
      eventType: 'auth.new_location_signin',
      aggregateType: 'user',
      payload: { countryCode: 'SE', country: 'Sweden', reason: 'new_country' },
    });
    expect(Value.Check(AuthNewLocationSigninEvent, e.payload)).toBe(true);
    expect(JSON.stringify(e)).not.toContain(SWEDEN);
    expect(JSON.stringify(e)).not.toContain(LONDON);
  });

  it('dedupe: the same new location twice in 24 h alerts once', async () => {
    await userWithOrg('b@example.com');
    peer = SWEDEN;
    await login('b@example.com');
    peer = LONDON;
    await login('b@example.com');
    expect(sessions.outbox).toHaveLength(1);
  });

  it('per-user cap: at most 3 alerts in 24 h even for 4 new countries', async () => {
    await userWithOrg('c@example.com');
    for (const ip of [SWEDEN, CHINA, '2.125.160.1', '2001:218::1']) {
      peer = ip;
      await login('c@example.com');
    }
    expect(sessions.outbox.map((e) => e.payload.countryCode)).toEqual(['SE', 'CN', 'CA']);
  });

  it('no active organization: no alert (documented limitation)', async () => {
    await signupAndLogin(app, 'd@example.com');
    peer = SWEDEN;
    await login('d@example.com');
    expect(sessions.outbox).toHaveLength(0);
  });

  it('signup/verify/password flows never alert (login only)', async () => {
    peer = SWEDEN;
    await userWithOrg('e@example.com');
    expect(sessions.outbox).toHaveLength(0);
  });
});
