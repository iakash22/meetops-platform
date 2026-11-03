import { afterEach, describe, expect, it } from 'vitest';
import {
  ConnectionRateLimiter,
  MAX_HTTP_BUFFER_SIZE,
  clientIp,
  createMemoryConcurrencyTracker,
  createRedisConcurrencyTracker,
  loadRealtimeConfig,
} from '../src/index.js';
import { MEETING_A, ORIGIN, connect, connected, runCleanups, start, web } from './fixtures.js';

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
      trustProxyHops: 0,
      maxSocketsPerUser: 20,
      maxSocketsPerIp: 50,
      joinLimitPerSocket: 30,
      maxRoomsPerSocket: 50,
    });
    expect(
      loadRealtimeConfig({ REALTIME_CORS_ORIGINS: ORIGIN, REALTIME_TRUST_PROXY_HOPS: '2' })
        .trustProxyHops,
    ).toBe(2);
    expect(() =>
      loadRealtimeConfig({ REALTIME_CORS_ORIGINS: ORIGIN, REALTIME_TRUST_PROXY_HOPS: '-1' }),
    ).toThrow();
  });

  it('caps Socket.IO message size at 16 KiB', async () => {
    const { io } = await start();
    expect(MAX_HTTP_BUFFER_SIZE).toBe(16_384);
    expect(
      (io.engine as unknown as { opts: { maxHttpBufferSize: number } }).opts.maxHttpBufferSize,
    ).toBe(16_384);
  });
});

describe('clientIp (trusted proxy hops)', () => {
  const hs = (xff?: string) => ({
    address: '10.0.0.9',
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  });
  it('ignores X-Forwarded-For with 0 hops', () => {
    expect(clientIp(hs('1.1.1.1'), 0)).toBe('10.0.0.9');
  });
  it('takes the Nth entry from the right', () => {
    expect(clientIp(hs('6.6.6.6, 1.1.1.1, 2.2.2.2'), 1)).toBe('2.2.2.2');
    expect(clientIp(hs('6.6.6.6, 1.1.1.1, 2.2.2.2'), 2)).toBe('1.1.1.1');
  });
  it('falls back to the socket address when the header is short or missing', () => {
    expect(clientIp(hs('1.1.1.1'), 2)).toBe('10.0.0.9');
    expect(clientIp(hs(), 1)).toBe('10.0.0.9');
  });
  it('drives the per-IP connection limit', async () => {
    const { url } = await start(
      {},
      { REALTIME_TRUST_PROXY_HOPS: '1', REALTIME_CONN_LIMIT_PER_IP: '1' },
    );
    const xff = (ip: string) => ({ 'x-forwarded-for': ip });
    await connected(connect(url, { cookie: 'a1', headers: xff('5.5.5.5') }));
    // Same proxy hop, different client IP: its own budget.
    await connected(connect(url, { cookie: 'a2', headers: xff('7.7.7.7') }));
    // Same client IP again: over the per-IP limit.
    await expect(
      connected(connect(url, { cookie: 'a2', headers: xff('5.5.5.5') })),
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

  it('redis tracker uses INCR/DECR and rolls back over the cap', async () => {
    const store = new Map<string, number>();
    const redis = {
      incr: async (k: string) => {
        store.set(k, (store.get(k) ?? 0) + 1);
        return store.get(k)!;
      },
      decr: async (k: string) => {
        store.set(k, (store.get(k) ?? 0) - 1);
        return store.get(k)!;
      },
      expire: async () => true,
    };
    const c = createRedisConcurrencyTracker(redis);
    expect(await c.acquire('user:u1', 1)).toBe(true);
    expect(await c.acquire('user:u1', 1)).toBe(false);
    expect(store.get('meetops:realtime:conns:user:u1')).toBe(1);
    await c.release('user:u1');
    expect(store.get('meetops:realtime:conns:user:u1')).toBe(0);
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
