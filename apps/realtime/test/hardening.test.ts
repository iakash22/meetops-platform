import { afterEach, describe, expect, it } from 'vitest';
import {
  ConnectionRateLimiter,
  MAX_HTTP_BUFFER_SIZE,
  clientIp,
  createMemoryConcurrencyTracker,
  createRedisConcurrencyTracker,
  REDIS_ACQUIRE_SCRIPT,
  REDIS_RELEASE_SCRIPT,
  loadRealtimeConfig,
} from '../src/index.js';
import {
  MEETING_A,
  ORIGIN,
  connect,
  connected,
  fakeVerifier,
  runCleanups,
  start,
  web,
} from './fixtures.js';

afterEach(runCleanups);

const uuid = (i: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${i.toString(16).padStart(12, '0')}`;

describe('config hardening', () => {
  it('rejects http: origins unless NODE_ENV=development', () => {
    expect(() => loadRealtimeConfig({ REALTIME_CORS_ORIGINS: 'http://a.example' })).toThrow(
      /https/,
    );
    expect(
      loadRealtimeConfig({ REALTIME_CORS_ORIGINS: 'http://a.example', NODE_ENV: 'development' })
        .corsOrigins,
    ).toEqual(['http://a.example']);
  });

  it('requires a rediss:// REDIS_URL in production', () => {
    const base = { REALTIME_CORS_ORIGINS: ORIGIN, NODE_ENV: 'production' };
    expect(() => loadRealtimeConfig(base)).toThrow(/REDIS_URL/);
    expect(() => loadRealtimeConfig({ ...base, REDIS_URL: 'redis://x' })).toThrow(/rediss/);
    expect(loadRealtimeConfig({ ...base, REDIS_URL: 'rediss://x' }).redisUrl).toBe('rediss://x');
  });

  it('parses the new limits with defaults', () => {
    expect(loadRealtimeConfig({ REALTIME_CORS_ORIGINS: ORIGIN })).toMatchObject({
      behindCloudflare: false,
      maxSocketsPerUser: 20,
      maxSocketsPerIp: 50,
      joinLimitPerSocket: 30,
      maxRoomsPerSocket: 50,
    });
  });

  it('reads TRUST_PROXY with the API rules and rejects the removed REALTIME_TRUST_PROXY_HOPS', () => {
    const base = { REALTIME_CORS_ORIGINS: ORIGIN };
    // Missing config: trust nothing (socket peer).
    expect(loadRealtimeConfig(base).trustProxy('10.0.0.1', 0)).toBe(false);
    const cfg = loadRealtimeConfig({ ...base, TRUST_PROXY: '10.0.0.0/8' });
    expect(cfg.trustProxy('10.1.2.3', 0)).toBe(true);
    expect(cfg.trustProxy('::ffff:10.1.2.3', 0)).toBe(true);
    expect(cfg.trustProxy('192.168.1.1', 0)).toBe(false);
    expect(() => loadRealtimeConfig({ ...base, TRUST_PROXY: 'true' })).toThrow(/not allowed/);
    expect(() => loadRealtimeConfig({ ...base, TRUST_PROXY: '0.0.0.0/0' })).toThrow(/invalid/);
    expect(() =>
      loadRealtimeConfig({
        ...base,
        TRUST_PROXY: '1',
        NODE_ENV: 'production',
        REDIS_URL: 'rediss://x',
      }),
    ).toThrow(/production/);
    expect(loadRealtimeConfig({ ...base, TRUST_PROXY: '1' }).trustProxy('10.0.0.1', 0)).toBe(true);
    expect(() => loadRealtimeConfig({ ...base, REALTIME_TRUST_PROXY_HOPS: '1' })).toThrow(
      /TRUST_PROXY/,
    );
    expect(loadRealtimeConfig({ ...base, REALTIME_TRUST_PROXY_HOPS: '0' })).toBeTruthy();
    expect(loadRealtimeConfig({ ...base, BEHIND_CLOUDFLARE: 'true' }).behindCloudflare).toBe(true);
  });

  it('caps Socket.IO message size at 16 KiB', async () => {
    const { io } = await start();
    expect(MAX_HTTP_BUFFER_SIZE).toBe(16_384);
    expect(
      (io.engine as unknown as { opts: { maxHttpBufferSize: number } }).opts.maxHttpBufferSize,
    ).toBe(16_384);
  });
});

describe('clientIp (TRUST_PROXY allowlist, same as the API)', () => {
  const hs = (address: string, xff?: string, extra: Record<string, string> = {}) => ({
    address,
    headers: { ...(xff === undefined ? {} : { 'x-forwarded-for': xff }), ...extra },
  });
  const cfg = (TRUST_PROXY?: string, more: Record<string, string> = {}) =>
    loadRealtimeConfig({
      REALTIME_CORS_ORIGINS: ORIGIN,
      ...(TRUST_PROXY === undefined ? {} : { TRUST_PROXY }),
      ...more,
    });

  it('missing config: ignores X-Forwarded-For and uses the socket peer', () => {
    expect(clientIp(hs('10.0.0.9', '1.1.1.1'), cfg())).toBe('10.0.0.9');
    expect(clientIp(hs('10.0.0.9', '1.1.1.1'), cfg(''))).toBe('10.0.0.9');
  });
  it('trusted proxy: uses the forwarded client IP', () => {
    expect(clientIp(hs('10.0.0.9', '203.0.113.7'), cfg('10.0.0.9'))).toBe('203.0.113.7');
  });
  it('untrusted peer: its X-Forwarded-For is ignored', () => {
    expect(clientIp(hs('198.51.100.4', '203.0.113.7'), cfg('10.0.0.9'))).toBe('198.51.100.4');
    // The old hop-count bug: one hop "trusted" a direct client's own header. Not any more.
    expect(clientIp(hs('198.51.100.4', '6.6.6.6, 7.7.7.7'), cfg('10.0.0.0/8'))).toBe(
      '198.51.100.4',
    );
  });
  it('multi-hop chain: skips trusted hops from the right and ignores a spoofed left-most entry', () => {
    const c = cfg('10.0.0.1,10.0.0.2');
    expect(clientIp(hs('10.0.0.1', '6.6.6.6, 203.0.113.7, 10.0.0.2'), c)).toBe('203.0.113.7');
    expect(clientIp(hs('10.0.0.1', '10.0.0.2, 203.0.113.7'), c)).toBe('203.0.113.7');
  });
  it('IPv6 and IPv4-mapped IPv6', () => {
    expect(clientIp(hs('2001:db8::1', '2a00:1450::5'), cfg('2001:db8::/32'))).toBe('2a00:1450::5');
    expect(clientIp(hs('::ffff:10.0.0.9', '203.0.113.7'), cfg('10.0.0.9'))).toBe('203.0.113.7');
    expect(clientIp(hs('::ffff:198.51.100.4', '203.0.113.7'), cfg('10.0.0.9'))).toBe(
      '198.51.100.4',
    );
  });
  it('a garbage entry from a trusted proxy falls back to the proxy address', () => {
    expect(clientIp(hs('10.0.0.9', 'not-an-ip'), cfg('10.0.0.9'))).toBe('10.0.0.9');
    expect(clientIp(hs('10.0.0.9', '1.1.1.1, 999.1.1.1'), cfg('10.0.0.9'))).toBe('10.0.0.9');
  });
  it('never reads the Forwarded header; CF-Connecting-IP only behind Cloudflare from a pinned edge', () => {
    expect(clientIp(hs('10.0.0.9', undefined, { forwarded: 'for=1.1.1.1' }), cfg('10.0.0.9'))).toBe(
      '10.0.0.9',
    );
    const cf = { 'cf-connecting-ip': '203.0.113.7' };
    expect(
      clientIp(hs('173.245.48.1', undefined, cf), cfg(undefined, { BEHIND_CLOUDFLARE: 'true' })),
    ).toBe('203.0.113.7');
    expect(
      clientIp(hs('198.51.100.4', undefined, cf), cfg(undefined, { BEHIND_CLOUDFLARE: 'true' })),
    ).toBe('198.51.100.4');
    expect(clientIp(hs('173.245.48.1', undefined, cf), cfg())).toBe('173.245.48.1');
  });
  it('matches Fastify request.ip (the API) for the same TRUST_PROXY, peer and header', async () => {
    const { default: Fastify } = await import('fastify');
    const { parseTrustProxy } = await import('@meetops/config');
    const cases: Array<[string, string, string | undefined]> = [
      ['10.0.0.1,10.0.0.2', '10.0.0.1', '6.6.6.6, 203.0.113.7, 10.0.0.2'],
      ['10.0.0.1,10.0.0.2', '10.0.0.1', '203.0.113.7, 10.0.0.2'],
      ['10.0.0.0/8', '198.51.100.4', '203.0.113.7'],
      ['10.0.0.0/8', '10.0.0.5', undefined],
      ['2001:db8::/32', '2001:db8::1', '2001:db8::2, 2a00:1450::5'],
      ['10.0.0.9', '::ffff:10.0.0.9', '203.0.113.7'],
      ['1', '10.0.0.9', '6.6.6.6, 1.1.1.1, 2.2.2.2'],
      ['', '10.0.0.9', '1.1.1.1'],
    ];
    for (const [tp, peer, xff] of cases) {
      const app = Fastify({ trustProxy: parseTrustProxy(tp) });
      app.get('/', (req) => ({ ip: req.ip }));
      const res = await app.inject({
        url: '/',
        remoteAddress: peer,
        headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
      });
      const apiIp = res.json<{ ip: string }>().ip.replace(/^::ffff:(?=\d+\.)/i, '');
      expect(clientIp(hs(peer, xff), cfg(tp)), `${tp} ${peer} ${xff}`).toBe(apiIp);
      await app.close();
    }
  });

  // Test clients connect from loopback; TRUST_PROXY lists it (both forms) to model nginx in front of realtime.
  const LOOPBACK = '127.0.0.1,::1';
  it('connection limit keys on the forwarded IP from a trusted proxy', async () => {
    const { url } = await start({}, { TRUST_PROXY: LOOPBACK, REALTIME_CONN_LIMIT_PER_IP: '1' });
    const xff = (ip: string) => ({ 'x-forwarded-for': ip });
    // A spoofed leading entry does not buy a fresh budget: only the proxy-appended (right-most) entry counts.
    await connected(connect(url, { cookie: 'a1', headers: xff('3.3.3.3, 4.4.4.4') }));
    await expect(
      connected(connect(url, { cookie: 'a2', headers: xff('9.9.9.9, 4.4.4.4') })),
    ).rejects.toThrow();
    await connected(connect(url, { cookie: 'a1', headers: xff('5.5.5.5') }));
    // Same proxy, different client IP: its own budget.
    await connected(connect(url, { cookie: 'a2', headers: xff('7.7.7.7') }));
    // Same client IP again: over the per-IP limit.
    await expect(
      connected(connect(url, { cookie: 'a2', headers: xff('5.5.5.5') })),
    ).rejects.toThrow();
  });
  it('untrusted peer cannot reset its connection budget by spoofing X-Forwarded-For', async () => {
    // Peer (loopback) is not in the allowlist, so every connection keys on the socket address.
    const { url } = await start({}, { TRUST_PROXY: '10.0.0.1', REALTIME_CONN_LIMIT_PER_IP: '1' });
    await connected(connect(url, { cookie: 'a1', headers: { 'x-forwarded-for': '1.1.1.1' } }));
    await expect(
      connected(connect(url, { cookie: 'a2', headers: { 'x-forwarded-for': '2.2.2.2' } })),
    ).rejects.toThrow();
    await expect(connected(connect(url, { cookie: 'a2' }))).rejects.toThrow();
  });
  it('missing TRUST_PROXY: spoofed X-Forwarded-For cannot evade the per-IP connection limit', async () => {
    const { url } = await start({}, { REALTIME_CONN_LIMIT_PER_IP: '1' });
    await connected(connect(url, { cookie: 'a1', headers: { 'x-forwarded-for': '1.1.1.1' } }));
    await expect(
      connected(connect(url, { cookie: 'a2', headers: { 'x-forwarded-for': '3.3.3.3' } })),
    ).rejects.toThrow();
  });
  it('concurrent per-IP socket cap keys on the resolved IP (spoofing from an untrusted peer does not help)', async () => {
    const { url } = await start({}, { TRUST_PROXY: '10.0.0.1', REALTIME_MAX_SOCKETS_PER_IP: '1' });
    await connected(connect(url, { cookie: 'a1', headers: { 'x-forwarded-for': '1.1.1.1' } }));
    await expect(
      connected(connect(url, { cookie: 'a2', headers: { 'x-forwarded-for': '2.2.2.2' } })),
    ).rejects.toThrow();
  });
  it('concurrent per-IP socket cap from a trusted proxy is per forwarded client', async () => {
    const { url } = await start({}, { TRUST_PROXY: LOOPBACK, REALTIME_MAX_SOCKETS_PER_IP: '1' });
    await connected(connect(url, { cookie: 'a1', headers: { 'x-forwarded-for': '1.1.1.1' } }));
    await connected(connect(url, { cookie: 'a2', headers: { 'x-forwarded-for': '2.2.2.2' } }));
    await expect(
      connected(connect(url, { cookie: 'a2', headers: { 'x-forwarded-for': '6.6.6.6, 1.1.1.1' } })),
    ).rejects.toThrow();
  });
});

describe('ConnectionRateLimiter LRU cap', () => {
  it('never holds more than maxKeys entries and evicts the least recently used', () => {
    const t = 0;
    const l = new ConnectionRateLimiter(60_000, () => t, 3);
    l.take('a', 5);
    l.take('b', 5);
    l.take('c', 5);
    l.take('a', 5); // a is now most recent
    l.take('d', 5); // evicts b
    expect(l.size).toBe(3);
    // b was evicted, so it starts fresh; a kept its count.
    for (let i = 0; i < 4; i++) l.take('a', 5);
    expect(l.take('a', 5)).toBe(false);
    expect(l.take('b', 1)).toBe(true);
    expect(l.size).toBe(3);
  });
});

describe('concurrent socket caps', () => {
  it('memory tracker enforces and releases', async () => {
    const c = createMemoryConcurrencyTracker();
    expect(await c.acquire('k', 1)).toBe(true);
    expect(await c.acquire('k', 1)).toBe(false);
    await c.release('k');
    expect(await c.acquire('k', 1)).toBe(true);
  });

  /** Emulates the two Lua scripts against an in-memory store with a controllable clock (seconds). */
  function fakeRedis() {
    let t = 0;
    const store = new Map<string, { n: number; expiresAt?: number }>();
    const expireCalls: string[] = [];
    const get = (k: string) => {
      const e = store.get(k);
      if (e?.expiresAt !== undefined && e.expiresAt <= t) store.delete(k);
      return store.get(k);
    };
    return {
      store,
      expireCalls,
      tick: (s: number) => (t += s),
      get: (k: string) => get(k)?.n,
      ttl: (k: string) => {
        const e = get(k);
        return e?.expiresAt === undefined ? undefined : e.expiresAt - t;
      },
      async eval(script: string, o: { keys: string[]; arguments: string[] }) {
        const key = o.keys[0]!;
        if (script === REDIS_ACQUIRE_SCRIPT) {
          const e = get(key) ?? { n: 0 };
          e.n += 1;
          store.set(key, e);
          if (e.n === 1) {
            e.expiresAt = t + Number(o.arguments[1]);
            expireCalls.push(key);
          }
          if (e.n > Number(o.arguments[0])) {
            e.n -= 1;
            if (e.n <= 0) store.delete(key);
            return 0;
          }
          return 1;
        }
        if (script === REDIS_RELEASE_SCRIPT) {
          const e = get(key);
          if (!e) return 0;
          e.n -= 1;
          if (e.n <= 0) store.delete(key);
          return e.n;
        }
        throw new Error('unexpected script');
      },
    };
  }

  it('redis tracker acquires atomically and rolls back over the cap', async () => {
    const r = fakeRedis();
    const c = createRedisConcurrencyTracker(r);
    const key = 'meetops:realtime:conns:user:u1';
    expect(await c.acquire('user:u1', 1)).toBe(true);
    expect(await c.acquire('user:u1', 1)).toBe(false);
    expect(r.get(key)).toBe(1);
    await c.release('user:u1');
    expect(r.get(key)).toBeUndefined();
    // Releasing an absent/expired key never drives the counter negative.
    await c.release('user:u1');
    expect(r.get(key)).toBeUndefined();
  });

  it('redis acquire script uses INCR + EXPIRE only on first increment (fixed window, not refreshed)', () => {
    expect(REDIS_ACQUIRE_SCRIPT).toMatch(/INCR/);
    expect(REDIS_ACQUIRE_SCRIPT).toMatch(/if n == 1 then redis\.call\('EXPIRE'/);
  });

  it('redis counter expires at the end of a fixed window that later attempts do not extend', async () => {
    const r = fakeRedis();
    const c = createRedisConcurrencyTracker(r, 100);
    const key = 'meetops:realtime:conns:ip:1.1.1.1';
    expect(await c.acquire('ip:1.1.1.1', 1)).toBe(true); // leaked: never released
    r.tick(60);
    expect(await c.acquire('ip:1.1.1.1', 1)).toBe(false);
    expect(r.ttl(key)).toBe(40); // not refreshed by the rejected attempt
    expect(r.expireCalls).toEqual([key]);
    r.tick(40);
    expect(r.get(key)).toBeUndefined();
    expect(await c.acquire('ip:1.1.1.1', 1)).toBe(true);
  });

  it('memory tracker expires a leaked slot after its fixed window and sweeps stale keys', async () => {
    let t = 0;
    const c = createMemoryConcurrencyTracker(1_000, () => t);
    expect(await c.acquire('k', 1)).toBe(true); // leaked
    t = 600;
    expect(await c.acquire('k', 1)).toBe(false); // does not refresh the window
    t = 1_000;
    expect(await c.acquire('k', 1)).toBe(true);
    for (let i = 0; i < 50; i++) await c.acquire(`stale:${i}`, 1);
    expect(c.size).toBe(51);
    t = 3_000;
    await c.acquire('fresh', 1);
    expect(c.size).toBe(1);
  });

  it('releases slots when the transport drops mid-handshake (disconnect never fires)', async () => {
    const base = createMemoryConcurrencyTracker();
    let acquired = 0;
    let released = 0;
    const concurrency = {
      acquire: async (k: string, l: number) => {
        const ok = await base.acquire(k, l);
        if (ok) acquired += 1;
        return ok;
      },
      release: async (k: string) => {
        released += 1;
        await base.release(k);
      },
    };
    let gate!: () => void;
    const verifierHeld = new Promise<void>((r) => (gate = r));
    let entered!: () => void;
    const inVerifier = new Promise<void>((r) => (entered = r));
    const { url } = await start(
      {
        concurrency,
        verifySession: async (c) => {
          entered();
          await verifierHeld;
          return fakeVerifier(c);
        },
      },
      { REALTIME_MAX_SOCKETS_PER_USER: '1', REALTIME_MAX_SOCKETS_PER_IP: '1' },
    );
    const s = web(url, 'a1');
    await inVerifier;
    s.disconnect(); // client goes away while the handshake is still being verified
    await new Promise((r) => setTimeout(r, 50));
    gate();
    await new Promise((r) => setTimeout(r, 50));
    expect(released).toBe(acquired);
    expect(base.size).toBe(0);
    // The slot is free: the same user/IP can connect again under a cap of 1.
    await connected(web(url, 'a1'));
  });

  it('releases slots acquired at handshake when a later cap rejects or the verifier throws', async () => {
    const base = createMemoryConcurrencyTracker();
    const { url } = await start({ concurrency: base }, { REALTIME_MAX_SOCKETS_PER_USER: '1' });
    const s1 = web(url, 'a1');
    await connected(s1);
    // Second socket: IP slot acquired, user cap rejects -> IP slot must be returned.
    await expect(connected(web(url, 'a1'))).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 20));
    expect(base.size).toBe(2); // only s1's ip + user keys
    s1.disconnect();
    await new Promise((r) => setTimeout(r, 50));
    expect(base.size).toBe(0);
  });

  it('rejects a second socket for the same user and frees the slot on disconnect', async () => {
    const { url } = await start({}, { REALTIME_MAX_SOCKETS_PER_USER: '1' });
    const s1 = web(url, 'a1');
    await connected(s1);
    await expect(connected(web(url, 'a1'))).rejects.toThrow();
    s1.disconnect();
    await new Promise((r) => setTimeout(r, 50));
    await connected(web(url, 'a1'));
  });

  it('caps sockets per IP', async () => {
    const { url } = await start({}, { REALTIME_MAX_SOCKETS_PER_IP: '1' });
    await connected(web(url, 'a1'));
    await expect(connected(web(url, 'a2'))).rejects.toThrow();
  });
});

describe('meeting:join / meeting:leave hardening', () => {
  const canAccessMeeting = () => true;

  it('deduplicates joins without re-running the access check', async () => {
    let checks = 0;
    const { url } = await start({ canAccessMeeting: () => (checks++, true) });
    const s = web(url, 'a1');
    await connected(s);
    expect(await s.emitWithAck('meeting:join', { meetingId: MEETING_A })).toEqual({ ok: true });
    expect(await s.emitWithAck('meeting:join', { meetingId: MEETING_A })).toEqual({ ok: true });
    expect(checks).toBe(1);
  });

  it('rate-limits meeting:join per socket', async () => {
    const { url } = await start({ canAccessMeeting }, { REALTIME_JOIN_LIMIT_PER_SOCKET: '2' });
    const s = web(url, 'a1');
    await connected(s);
    expect(await s.emitWithAck('meeting:join', { meetingId: uuid(1) })).toEqual({ ok: true });
    expect(await s.emitWithAck('meeting:join', { meetingId: uuid(2) })).toEqual({ ok: true });
    expect(await s.emitWithAck('meeting:join', { meetingId: uuid(3) })).toEqual({
      ok: false,
      error: 'limit',
    });
  });

  it('caps meeting rooms per socket and frees a slot on leave', async () => {
    const { url } = await start({ canAccessMeeting }, { REALTIME_MAX_ROOMS_PER_SOCKET: '2' });
    const s = web(url, 'a1');
    await connected(s);
    await s.emitWithAck('meeting:join', { meetingId: uuid(1) });
    await s.emitWithAck('meeting:join', { meetingId: uuid(2) });
    expect(await s.emitWithAck('meeting:join', { meetingId: uuid(3) })).toEqual({
      ok: false,
      error: 'limit',
    });
    expect(await s.emitWithAck('meeting:leave', { meetingId: uuid(1) })).toEqual({ ok: true });
    expect(await s.emitWithAck('meeting:join', { meetingId: uuid(3) })).toEqual({ ok: true });
  });

  it('validates the meeting:leave id', async () => {
    const { url } = await start();
    const s = web(url, 'a1');
    await connected(s);
    expect(await s.emitWithAck('meeting:leave', { meetingId: 'not-a-uuid' })).toEqual({
      ok: false,
      error: 'invalid',
    });
  });
});
