import { afterEach, describe, expect, it } from 'vitest';
import {
  emitToMeeting,
  emitToOrg,
  loadRealtimeConfig,
  toMeetingStatus,
  type MeetingStatusEvent,
} from '../src/index.js';
import {
  EXT_ID,
  EXT_ORIGIN,
  MEETING_A,
  ORG_A,
  ORIGIN,
  connect,
  connected,
  nextEvent,
  runCleanups,
  start,
  web,
} from './fixtures.js';

afterEach(runCleanups);

describe('status mapping', () => {
  it('maps uploaded/transcribing to processing + stage', () => {
    expect(toMeetingStatus('uploaded')).toEqual({ status: 'processing' });
    expect(toMeetingStatus('transcribing')).toEqual({
      status: 'processing',
      stage: 'transcribing',
    });
    expect(toMeetingStatus('completed')).toEqual({ status: 'completed' });
  });
});

describe('config', () => {
  it('parses env', () => {
    expect(loadRealtimeConfig({ REALTIME_CORS_ORIGINS: ORIGIN })).toMatchObject({
      port: 4001,
      corsOrigins: [ORIGIN],
      extensionOrigins: [],
      sessionCookieName: '__Host-meetops_sid',
      path: '/socket.io',
    });
    expect(
      loadRealtimeConfig({
        REDIS_URL: 'redis://x',
        NODE_ENV: 'development',
        REALTIME_CORS_ORIGINS: 'http://localhost:3000, https://b.example',
      }),
    ).toMatchObject({
      redisUrl: 'redis://x',
      corsOrigins: ['http://localhost:3000', 'https://b.example'],
    });
    expect(() =>
      loadRealtimeConfig({ REALTIME_CORS_ORIGINS: ORIGIN, REALTIME_PORT: 'abc' }),
    ).toThrow();
    expect(() => loadRealtimeConfig({})).toThrow(/REALTIME_CORS_ORIGINS is required/);
    expect(() => loadRealtimeConfig({ REALTIME_CORS_ORIGINS: '*' })).toThrow();
    expect(() => loadRealtimeConfig({ REALTIME_CORS_ORIGINS: 'https://a.example/path' })).toThrow();
    expect(() => loadRealtimeConfig({ REALTIME_CORS_ORIGINS: 'ftp://a.example' })).toThrow();
  });

  it('parses REALTIME_EXTENSION_IDS and the dev cookie name', () => {
    expect(
      loadRealtimeConfig({ REALTIME_CORS_ORIGINS: ORIGIN, REALTIME_EXTENSION_IDS: ` ${EXT_ID} ,` })
        .extensionOrigins,
    ).toEqual([EXT_ORIGIN]);
    expect(() =>
      loadRealtimeConfig({ REALTIME_CORS_ORIGINS: ORIGIN, REALTIME_EXTENSION_IDS: 'not-an-id' }),
    ).toThrow(/REALTIME_EXTENSION_IDS/);
    expect(() =>
      loadRealtimeConfig({ REALTIME_CORS_ORIGINS: ORIGIN, REALTIME_EXTENSION_IDS: '*' }),
    ).toThrow();
    expect(
      loadRealtimeConfig({ REALTIME_CORS_ORIGINS: ORIGIN, NODE_ENV: 'development' })
        .sessionCookieName,
    ).toBe('meetops_sid');
    expect(
      loadRealtimeConfig({
        REALTIME_CORS_ORIGINS: ORIGIN,
        NODE_ENV: 'production',
        REDIS_URL: 'rediss://x',
      }).sessionCookieName,
    ).toBe('__Host-meetops_sid');
  });
});

describe('realtime server', () => {
  it('GET /health', async () => {
    const { app } = await start();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', adapter: 'memory' });
  });

  it('rejects handshakes with a missing or disallowed Origin', async () => {
    const { url } = await start();
    await expect(connected(connect(url, { cookie: 'a1', origin: null }))).rejects.toThrow();
    await expect(
      connected(connect(url, { cookie: 'a1', origin: 'https://evil.example' })),
    ).rejects.toThrow();
    await expect(
      connected(connect(url, { cookie: 'a1', origin: 'https://app.example.com.evil.example' })),
    ).rejects.toThrow();
    await expect(
      connected(
        connect(url, {
          token: 'xa1',
          origin: 'chrome-extension://pppppppppppppppppppppppppppppppp',
        }),
      ),
    ).rejects.toThrow();
    await connected(web(url, 'a1'));
  });

  it('uses organization-scoped rooms (organizations:{organizationId})', async () => {
    const { io, url } = await start();
    const a1 = web(url, 'a1');
    await connected(a1);
    expect(await a1.emitWithAck('meeting:join', { meetingId: MEETING_A })).toEqual({ ok: true });
    const rooms = [...(io.sockets.sockets.values().next().value?.rooms ?? [])];
    expect(rooms).toEqual(
      expect.arrayContaining([
        `organizations:${ORG_A}`,
        `organizations:${ORG_A}:meetings:${MEETING_A}`,
      ]),
    );
    expect(rooms).not.toContain(`meeting:${MEETING_A}`);
    expect(rooms.some((r) => r.startsWith('org:'))).toBe(false);
  });

  it('scopes org and meeting rooms', async () => {
    const { io, url } = await start();
    const a1 = web(url, 'a1');
    const a2 = web(url, 'a2');
    const b1 = web(url, 'b1');
    await Promise.all([connected(a1), connected(a2), connected(b1)]);

    expect(await a1.emitWithAck('meeting:join', { meetingId: MEETING_A })).toEqual({ ok: true });
    expect(await b1.emitWithAck('meeting:join', { meetingId: MEETING_A })).toEqual({
      ok: false,
      error: 'forbidden',
    });
    expect(await b1.emitWithAck('meeting:join', { meetingId: '../x' })).toEqual({
      ok: false,
      error: 'invalid',
    });

    const ev: MeetingStatusEvent = {
      meetingId: MEETING_A,
      organizationId: ORG_A,
      status: 'processing',
      at: new Date().toISOString(),
    };
    const [ra1, ra2, rb1] = [
      nextEvent(a1, 'meeting:status'),
      nextEvent(a2, 'meeting:status'),
      nextEvent(b1, 'meeting:status'),
    ];
    emitToMeeting(io, ORG_A, MEETING_A, 'meeting:status', ev);
    expect(await ra1).toEqual(ev);
    expect(await ra2).toBe('timeout');
    expect(await rb1).toBe('timeout');

    const task = { taskId: 't1', organizationId: ORG_A, status: 'todo' as const, at: ev.at };
    const [ta1, ta2, tb1] = [
      nextEvent(a1, 'task:update'),
      nextEvent(a2, 'task:update'),
      nextEvent(b1, 'task:update'),
    ];
    emitToOrg(io, ORG_A, 'task:update', task);
    expect(await ta1).toEqual(task);
    expect(await ta2).toEqual(task);
    expect(await tb1).toBe('timeout');

    expect(await a1.emitWithAck('meeting:leave', { meetingId: MEETING_A })).toEqual({ ok: true });
    const after = nextEvent(a1, 'meeting:status');
    emitToMeeting(io, ORG_A, MEETING_A, 'meeting:status', ev);
    expect(await after).toBe('timeout');
  });
});
