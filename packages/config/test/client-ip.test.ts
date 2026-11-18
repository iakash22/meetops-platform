import { describe, expect, it } from 'vitest';
import {
  compileTrustProxy,
  normalizeIp,
  parseTrustProxy,
  resolveClientIp,
  resolveForwardedIp,
} from '../src/client-ip.js';

const trust = (v: string | undefined, production = false) =>
  compileTrustProxy(parseTrustProxy(v, { production }));

describe('parseTrustProxy (shared by API and realtime)', () => {
  it('unset, empty and "false" trust nothing', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('  ')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
  });
  it('rejects true, /0, invalid entries, and hop counts in production', () => {
    expect(() => parseTrustProxy('true')).toThrow(/not allowed/);
    expect(() => parseTrustProxy('0.0.0.0/0')).toThrow(/invalid/);
    expect(() => parseTrustProxy('::/0')).toThrow(/invalid/);
    expect(() => parseTrustProxy('10.0.0.1,nginx')).toThrow(/nginx/);
    expect(() => parseTrustProxy('1', { production: true })).toThrow(/production/);
    expect(typeof parseTrustProxy('1')).toBe('function');
  });
  it('accepts an IP/CIDR allowlist', () => {
    expect(parseTrustProxy('10.0.0.1, 172.16.0.0/12,2001:db8::/32')).toEqual([
      '10.0.0.1',
      '172.16.0.0/12',
      '2001:db8::/32',
    ]);
  });
});

describe('resolveForwardedIp', () => {
  it('missing config: X-Forwarded-For is ignored and the socket peer is used', () => {
    for (const v of [undefined, '', 'false']) {
      expect(resolveForwardedIp('10.0.0.9', '1.1.1.1', trust(v))).toBe('10.0.0.9');
    }
  });
  it('trusted proxy peer: the forwarded client IP is used', () => {
    expect(resolveForwardedIp('10.0.0.9', '203.0.113.7', trust('10.0.0.0/8'))).toBe('203.0.113.7');
  });
  it('untrusted peer: its X-Forwarded-For is ignored', () => {
    expect(resolveForwardedIp('198.51.100.4', '203.0.113.7', trust('10.0.0.0/8'))).toBe(
      '198.51.100.4',
    );
  });
  it('multi-hop: walks from the right, skips trusted hops, ignores a spoofed left-most entry', () => {
    const t = trust('10.0.0.1,10.0.0.2');
    // client 203.0.113.7 sent "XFF: 6.6.6.6"; proxy 10.0.0.2 appended the client; proxy 10.0.0.1 appended 10.0.0.2.
    expect(resolveForwardedIp('10.0.0.1', '6.6.6.6, 203.0.113.7, 10.0.0.2', t)).toBe('203.0.113.7');
    // A forged trusted-looking entry left of an untrusted hop is never reached.
    expect(resolveForwardedIp('10.0.0.1', '10.0.0.2, 203.0.113.7', t)).toBe('203.0.113.7');
    // Every hop trusted: the left-most entry is the client (what Fastify returns too).
    expect(resolveForwardedIp('10.0.0.1', '203.0.113.7, 10.0.0.2', t)).toBe('203.0.113.7');
  });
  it('repeated X-Forwarded-For headers are joined in order', () => {
    expect(resolveForwardedIp('10.0.0.1', ['6.6.6.6', '203.0.113.7'], trust('10.0.0.1'))).toBe(
      '203.0.113.7',
    );
  });
  it('IPv6 peers and entries', () => {
    const t = trust('2001:db8::/32');
    expect(resolveForwardedIp('2001:db8::1', '2001:db8:ffff::9, 2a00:1450::5', t)).toBe(
      '2a00:1450::5',
    );
    expect(resolveForwardedIp('2a00:1450::5', '203.0.113.7', t)).toBe('2a00:1450::5');
  });
  it('IPv4-mapped IPv6 peer matches an IPv4 allowlist entry and results are normalised', () => {
    const t = trust('10.0.0.9');
    expect(resolveForwardedIp('::ffff:10.0.0.9', '203.0.113.7', t)).toBe('203.0.113.7');
    expect(resolveForwardedIp('::ffff:10.0.0.9', '::ffff:203.0.113.7', t)).toBe('203.0.113.7');
    // Untrusted mapped peer: header ignored, peer normalised to IPv4 (one key per client).
    expect(resolveForwardedIp('::ffff:198.51.100.4', '203.0.113.7', t)).toBe('198.51.100.4');
  });
  it('a garbage entry from a trusted proxy falls back to the nearest valid hop', () => {
    const t = trust('10.0.0.1');
    expect(resolveForwardedIp('10.0.0.1', 'not-an-ip', t)).toBe('10.0.0.1');
    expect(resolveForwardedIp('10.0.0.1', '1.1.1.1, 999.1.1.1', t)).toBe('10.0.0.1');
  });
  it('dev/test hop count keeps the old hop semantics', () => {
    expect(resolveForwardedIp('10.0.0.9', '6.6.6.6, 1.1.1.1, 2.2.2.2', trust('1'))).toBe('2.2.2.2');
    expect(resolveForwardedIp('10.0.0.9', '6.6.6.6, 1.1.1.1, 2.2.2.2', trust('2'))).toBe('1.1.1.1');
  });
  it('missing peer → null', () => {
    expect(resolveForwardedIp(undefined, '1.1.1.1', trust('10.0.0.1'))).toBeNull();
  });
});

describe('resolveClientIp (Cloudflare) and normalizeIp', () => {
  it('honours CF-Connecting-IP only behind Cloudflare from a pinned edge', () => {
    const on = { behindCloudflare: true };
    expect(resolveClientIp('173.245.48.1', '203.0.113.7', on)).toBe('203.0.113.7');
    expect(resolveClientIp('198.51.100.4', '203.0.113.7', on)).toBe('198.51.100.4');
    expect(resolveClientIp('173.245.48.1', '203.0.113.7', { behindCloudflare: false })).toBe(
      '173.245.48.1',
    );
  });
  it('normalizes mapped IPv6 and zone ids', () => {
    expect(normalizeIp('::ffff:1.2.3.4')).toBe('1.2.3.4');
    expect(normalizeIp('fe80::1%eth0')).toBe('fe80::1');
    expect(normalizeIp('nope')).toBeNull();
  });
});
