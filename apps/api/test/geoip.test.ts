import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { Value } from '@sinclair/typebox/value';
import { SessionSummary } from '@meetops/contracts';
import {
  CLOUDFLARE_IPV4_RANGES,
  EMPTY_GEO,
  MmdbGeoIpProvider,
  createGeoIpProvider,
  isPublicIp,
  lookupGeo,
  nullGeoIpProvider,
  resolveClientIp,
  safeGeoText,
  truncateIp,
} from '../src/shared/geoip/index.js';
import { parseTrustProxy } from '../src/shared/trust-proxy.js';
import { InMemoryAuditLog, type AuditEvent } from '../src/modules/auth/domain/audit.js';
import { InMemorySessionRepository } from '../src/modules/auth/infrastructure/in-memory-session.repository.js';
import { LoggerAuditLog } from '../src/modules/auth/infrastructure/prisma/prisma-audit.log.js';
import { buildApp, Client, signupAndLogin, PASSWORD, type App } from './helpers.js';

/** Fictional fixture; provenance in test/fixtures/geoip/generate-fixture.py. */
const FIXTURE = fileURLToPath(new URL('./fixtures/geoip/test-city.mmdb', import.meta.url));
const LONDON = '81.2.69.142';
const SWEDEN = '89.160.20.112';

describe('GeoIP provider (fixture mmdb, local only)', () => {
  const p = new MmdbGeoIpProvider(FIXTURE);
  it('returns coarse fields with geoApproximate=true and never lat/long', () => {
    const g = lookupGeo(p, LONDON);
    expect(g).toEqual({
      geoCity: 'London',
      geoRegion: 'England',
      geoCountry: 'United Kingdom',
      geoCountryCode: 'GB',
      geoApproximate: true,
    });
    expect(lookupGeo(p, SWEDEN)).toMatchObject({ geoCity: 'Linköping', geoCountryCode: 'SE' });
    expect(lookupGeo(p, '2.125.160.216').geoCity).toBe("St. John's");
    expect(lookupGeo(p, '2001:218::1')).toEqual({
      ...EMPTY_GEO,
      geoCountry: 'Japan',
      geoCountryCode: 'JP',
      geoApproximate: true,
    });
    expect(lookupGeo(p, `::ffff:${LONDON}`).geoCity).toBe('London');
  });
  it('private, reserved, unknown and invalid IPs give all-null fields', () => {
    for (const ip of [
      '10.0.0.1',
      '192.168.1.1',
      '127.0.0.1',
      '100.64.0.1',
      '169.254.1.1',
      '203.0.113.7',
      '::1',
      'fd00::1',
      'fe80::1',
      '2001:db8::1',
      '8.8.8.8',
      'nope',
      '',
      null,
    ]) {
      expect(lookupGeo(p, ip), String(ip)).toEqual(EMPTY_GEO);
    }
  });
  it('sanitises hostile mmdb text (CRLF, bidi, HTML) and drops IP-looking names and bad codes', () => {
    const g = lookupGeo(p, '1.128.0.1');
    expect(g.geoCity).toBe('Evil Bcc: x');
    expect(g.geoRegion).toBe('Reversed');
    expect(g.geoCountry).toBe('Aus b tralia');
    expect(g.geoCountryCode).toBe('AU');
    const ipish = lookupGeo(p, '5.6.7.8');
    expect(ipish).toMatchObject({
      geoCity: null,
      geoRegion: null,
      geoCountry: 'Nowhere',
      geoCountryCode: null,
    });
    expect(safeGeoText('Trinidad & Tobago')).toBe('Trinidad & Tobago');
  });
  it('a throwing provider never breaks the caller', () => {
    expect(
      lookupGeo(
        {
          name: 'x',
          lookupPublic: () => {
            throw new Error('boom');
          },
        },
        LONDON,
      ),
    ).toEqual(EMPTY_GEO);
  });
  it('factory: none / missing file give the null provider; unknown provider names fail; no fallback', () => {
    expect(createGeoIpProvider({})).toBe(nullGeoIpProvider);
    expect(createGeoIpProvider({ GEOIP_PROVIDER: 'none', GEOIP_DB_PATH: FIXTURE })).toBe(
      nullGeoIpProvider,
    );
    expect(
      createGeoIpProvider({ GEOIP_PROVIDER: 'dbip', GEOIP_DB_PATH: '/nonexistent.mmdb' }),
    ).toBe(nullGeoIpProvider);
    expect(createGeoIpProvider({ GEOIP_DB_PATH: FIXTURE }).name).toBe('dbip-city-lite');
    expect(createGeoIpProvider({ GEOIP_PROVIDER: 'geolite2', GEOIP_DB_PATH: FIXTURE }).name).toBe(
      'geolite2-city',
    );
    expect(() => createGeoIpProvider({ GEOIP_PROVIDER: 'ipinfo' })).toThrow();
  });
  it('isPublicIp', () => {
    expect(isPublicIp(LONDON)).toBe(true);
    expect(isPublicIp('10.1.2.3')).toBe(false);
  });
});

describe('client IP and logging', () => {
  const cf = CLOUDFLARE_IPV4_RANGES[0].replace('0/20', '1');
  it('CF-Connecting-IP only when BEHIND_CLOUDFLARE and the peer is a pinned Cloudflare address', () => {
    expect(resolveClientIp(cf, LONDON, { behindCloudflare: true })).toBe(LONDON);
    expect(resolveClientIp(cf, LONDON, { behindCloudflare: false })).toBe(cf);
    expect(resolveClientIp(SWEDEN, LONDON, { behindCloudflare: true })).toBe(SWEDEN);
    expect(resolveClientIp(cf, 'not-an-ip', { behindCloudflare: true })).toBe(cf);
    expect(resolveClientIp(cf, [LONDON, SWEDEN], { behindCloudflare: true })).toBe(cf);
  });
  it('TRUST_PROXY: hop count rejected in production, CIDR list accepted', () => {
    expect(() => parseTrustProxy('1', { production: true })).toThrow(/production/);
    expect(parseTrustProxy('10.0.0.0/8', { production: true })).toEqual(['10.0.0.0/8']);
    expect(typeof parseTrustProxy('1')).toBe('function');
  });
  it('truncates IPs for logs (/24, /48)', () => {
    expect(truncateIp(LONDON)).toBe('81.2.69.0/24');
    expect(truncateIp('2001:db8:abcd:12:1::5')).toBe('2001:db8:abcd::/48');
    expect(truncateIp('2001:db8::1')).toBe('2001:db8:0::/48');
    expect(truncateIp(null)).toBeNull();
  });
  it('LoggerAuditLog never logs the full IP', async () => {
    const lines: unknown[] = [];
    await new LoggerAuditLog({ info: (o) => lines.push(o) }).record({
      organizationId: null,
      actorId: null,
      action: 'auth.login',
      targetType: 'session',
      targetId: null,
      metadata: {},
      ip: LONDON,
      userAgent: null,
    } as unknown as AuditEvent);
    expect(JSON.stringify(lines)).not.toContain(LONDON);
    expect(JSON.stringify(lines)).toContain('81.2.69.0/24');
  });
});

describe('sessions and audit get geo (HTTP)', () => {
  let app: App;
  let audit: InMemoryAuditLog;
  let sessions: InMemorySessionRepository;
  let peer = LONDON;
  beforeEach(async () => {
    audit = new InMemoryAuditLog();
    sessions = new InMemorySessionRepository();
    app = await buildApp({ audit, sessions, geoIp: new MmdbGeoIpProvider(FIXTURE) });
    const inject = app.inject.bind(app) as (o: object) => ReturnType<App['inject']>;
    (app as unknown as { inject: (o: object) => unknown }).inject = (o: object) =>
      inject({ ...o, remoteAddress: peer });
  });
  afterEach(async () => {
    peer = LONDON;
    await app.close();
  });

  it('fills session + audit geo at sign-in and SessionSummary validates', async () => {
    const c = await signupAndLogin(app, 'geo@example.com');
    const list = (await c.get('/auth/sessions')).json();
    expect(list.items[0]).toMatchObject({
      geoCity: 'London',
      geoRegion: 'England',
      geoCountry: 'United Kingdom',
      geoCountryCode: 'GB',
      geoApproximate: true,
    });
    for (const s of list.items) expect(Value.Check(SessionSummary, s)).toBe(true);
    const login = audit.events.find((e) => e.action.startsWith('auth.login') && e.geo?.geoCity);
    expect(login?.geo).toMatchObject({ geoCountryCode: 'GB', geoApproximate: true });
  });

  it('looks up again when the session IP changes, and private IPs give no geo fields', async () => {
    const c = await signupAndLogin(app, 'move@example.com');
    peer = SWEDEN;
    const moved = (await c.get('/auth/sessions')).json().items[0];
    expect(moved).toMatchObject({ geoCountryCode: 'SE', ip: SWEDEN });
    peer = '10.0.0.5';
    const priv = (await c.get('/auth/sessions')).json().items[0];
    expect(priv.ip).toBe('10.0.0.5');
    for (const k of ['geoCity', 'geoRegion', 'geoCountry', 'geoCountryCode', 'geoApproximate']) {
      expect(priv).not.toHaveProperty(k);
    }
    const fresh = new Client(app);
    await fresh.post('/auth/login', { email: 'move@example.com', password: PASSWORD });
    expect(
      [...(sessions as unknown as { items: Map<string, { geo?: unknown }> }).items.values()].pop()
        ?.geo,
    ).toEqual(EMPTY_GEO);
  });
});
