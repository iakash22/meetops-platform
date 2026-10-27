import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { readFileSync } from 'node:fs';
import {
  AUTH_NEW_LOCATION_SIGNIN_EVENT,
  AuthNewLocationSigninEvent,
  AuthNewLocationSigninNotificationPayload,
  SessionSummary,
} from '../src/index.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const sid = '00000000-0000-4000-8000-000000000001';
const at = '2026-10-28T10:00:00.000Z';
const base = {
  id: sid,
  current: true,
  createdAt: at,
  lastSeenAt: at,
  expiresAt: at,
  ip: null,
  userAgent: null,
};

describe('0.14.0 GeoIP sessions', () => {
  it('is 0.14.0 or later', () => expect(pkg.version).toMatch(/^0\.(1[4-9]|[2-9]\d|\d{3,})\.\d+$/));
  it('accepts SessionSummary with and without geo fields', () => {
    expect(Value.Check(SessionSummary, base)).toBe(true);
    const geo = {
      geoCity: 'Pune',
      geoRegion: 'Maharashtra',
      geoCountry: 'India',
      geoCountryCode: 'IN',
      geoApproximate: true,
    };
    expect(Value.Check(SessionSummary, { ...base, ...geo })).toBe(true);
    // Optional, not nullable: null is rejected for every geo field.
    for (const k of ['geoCity', 'geoRegion', 'geoCountry', 'geoCountryCode', 'geoApproximate']) {
      expect(Value.Check(SessionSummary, { ...base, [k]: null })).toBe(false);
    }
    expect(Value.Check(SessionSummary, { ...base, geoApproximate: false })).toBe(false);
  });
  it('rejects bad country codes and lat/long', () => {
    expect(Value.Check(SessionSummary, { ...base, geoCountryCode: 'in' })).toBe(false);
    expect(Value.Check(SessionSummary, { ...base, latitude: 1 })).toBe(false);
  });
  it('validates the outbox event and rejects an ip', () => {
    const ev = {
      sessionId: sid,
      city: 'Pune',
      region: 'Maharashtra',
      country: 'India',
      countryCode: 'IN',
      reason: 'new_region',
    };
    expect(AUTH_NEW_LOCATION_SIGNIN_EVENT).toBe('auth.new_location_signin');
    expect(Value.Check(AuthNewLocationSigninEvent, ev)).toBe(true);
    expect(Value.Check(AuthNewLocationSigninEvent, { ...ev, reason: 'other' })).toBe(false);
    expect(Value.Check(AuthNewLocationSigninEvent, { ...ev, ip: '1.2.3.4' })).toBe(false);
  });
  const unsafe = [
    'Pune\r\nBcc: x',
    'Pune\n',
    'Pu\u202Ene',
    'Pu\u2066ne',
    'Pune\u200B',
    'Pu\u0000ne',
    'Pu\u0007ne',
    'Pu\u0085ne',
    'Pu\u2028ne',
    '<b>Pune</b>',
    '<b>',
    'Pune>',
    'Pu"ne',
    ' Pune',
    'Pune ',
    '   ',
    'Pune\uDB40\uDC41',
  ];
  const ipLike = [
    '203.0.113.7',
    '10.0.0.1',
    '2001:db8::1',
    '::1',
    '::ffff:203.0.113.7',
    'fe80::1%eth0',
    'FE80::1',
  ];
  it('rejects CRLF, bidi, control, invisible and HTML chars in every geo text field', () => {
    for (const v of unsafe) {
      for (const k of ['geoCity', 'geoRegion', 'geoCountry']) {
        expect(Value.Check(SessionSummary, { ...base, [k]: v }), `${k}=${JSON.stringify(v)}`).toBe(
          false,
        );
      }
      const ev = {
        sessionId: sid,
        city: v,
        region: null,
        country: null,
        countryCode: null,
        reason: 'new_region',
      };
      expect(Value.Check(AuthNewLocationSigninEvent, ev)).toBe(false);
      expect(
        Value.Check(AuthNewLocationSigninNotificationPayload, {
          sessionId: sid,
          reason: 'new_region',
          geoCity: v,
        }),
      ).toBe(false);
    }
  });
  it('rejects IP-looking location strings (v4 and v6)', () => {
    for (const v of ipLike) {
      expect(Value.Check(SessionSummary, { ...base, geoCity: v }), v).toBe(false);
      const ev = {
        sessionId: sid,
        city: v,
        region: null,
        country: null,
        countryCode: null,
        reason: 'new_country',
      };
      expect(Value.Check(AuthNewLocationSigninEvent, ev), v).toBe(false);
    }
  });
  it('still accepts ordinary place names', () => {
    for (const v of [
      'São Paulo',
      'Zürich',
      'New Delhi',
      'St. John’s',
      "St. John's",
      'Trinidad & Tobago',
      "Coeur d'Alene",
      'Ho Chi Minh City',
      'Île-de-France',
      '東京',
      'Abu Dhabi',
      'Cafe 1',
    ]) {
      expect(Value.Check(SessionSummary, { ...base, geoCity: v }), v).toBe(true);
    }
  });
  it('validates the notification payload with optional geoCity/geoCountry', () => {
    const p = { sessionId: sid, reason: 'new_country' };
    expect(Value.Check(AuthNewLocationSigninNotificationPayload, p)).toBe(true);
    expect(
      Value.Check(AuthNewLocationSigninNotificationPayload, {
        ...p,
        geoCity: 'Paris',
        geoCountry: 'France',
      }),
    ).toBe(true);
    expect(Value.Check(AuthNewLocationSigninNotificationPayload, { ...p, ip: '1.2.3.4' })).toBe(
      false,
    );
  });
});
