import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import {
  createRealtimeServer,
  emitToMeeting,
  emitToOrg,
  loadRealtimeConfig,
  toMeetingStatus,
  type ClientToServerEvents,
  type ServerToClientEvents,
  type MeetingStatusEvent
} from '../src/index.js';

type C = ClientSocket<ServerToClientEvents, ClientToServerEvents>;
const TOKENS: Record<string, { userId: string; organizationId: string }> = {
  a1: { userId: 'u1', organizationId: 'orgA' },
  a2: { userId: 'u2', organizationId: 'orgA' },
  b1: { userId: 'u3', organizationId: 'orgB' }
};
const MEETINGS: Record<string, string> = { mA: 'orgA', mB: 'orgB' };

const ORIGIN = 'https://app.example.com';
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function start() {
  const { app, io } = await createRealtimeServer({
    config: loadRealtimeConfig({ REALTIME_PORT: '0', REALTIME_CORS_ORIGINS: ORIGIN }),
    verifySession: ({ token }) => (token ? (TOKENS[token] ?? null) : null),
    canAccessMeeting: ({ organizationId, meetingId }) => MEETINGS[meetingId] === organizationId
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  cleanups.push(() => app.close());
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return { app, io, url };
}

function connect(url: string, token?: string, origin: string | null = ORIGIN): C {
  const s: C = ioc(url, {
    auth: token ? { token } : {},
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    ...(origin ? { extraHeaders: { origin } } : {})
  });
  cleanups.push(() => void s.disconnect());
  return s;
}

const connected = (s: C) =>
  new Promise<void>((res, rej) => {
    s.once('connect', () => res());
    s.once('connect_error', rej);
  });

const nextEvent = <E extends keyof ServerToClientEvents>(s: C, e: E, ms = 300) =>
  new Promise<Parameters<ServerToClientEvents[E]>[0] | 'timeout'>((res) => {
    const t = setTimeout(() => res('timeout'), ms);
    s.once(e, ((p: Parameters<ServerToClientEvents[E]>[0]) => {
      clearTimeout(t);
      res(p);
    }) as never);
  });

describe('status mapping', () => {
  it('maps uploaded/transcribing to processing + stage', () => {
    expect(toMeetingStatus('uploaded')).toEqual({ status: 'processing' });
    expect(toMeetingStatus('transcribing')).toEqual({ status: 'processing', stage: 'transcribing' });
    expect(toMeetingStatus('completed')).toEqual({ status: 'completed' });
  });
});

describe('config', () => {
  it('parses env', () => {
    expect(loadRealtimeConfig({ REALTIME_CORS_ORIGINS: ORIGIN })).toMatchObject({ port: 4001, corsOrigins: [ORIGIN], path: '/socket.io' });
    expect(loadRealtimeConfig({ REDIS_URL: 'redis://x', REALTIME_CORS_ORIGINS: 'http://localhost:3000, https://b.example' })).toMatchObject({
      redisUrl: 'redis://x',
      corsOrigins: ['http://localhost:3000', 'https://b.example']
    });
    expect(() => loadRealtimeConfig({ REALTIME_CORS_ORIGINS: ORIGIN, REALTIME_PORT: 'abc' })).toThrow();
    expect(() => loadRealtimeConfig({})).toThrow(/REALTIME_CORS_ORIGINS is required/);
    expect(() => loadRealtimeConfig({ REALTIME_CORS_ORIGINS: '*' })).toThrow();
    expect(() => loadRealtimeConfig({ REALTIME_CORS_ORIGINS: 'https://a.example/path' })).toThrow();
    expect(() => loadRealtimeConfig({ REALTIME_CORS_ORIGINS: 'ftp://a.example' })).toThrow();
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
    await expect(connected(connect(url, 'a1', null))).rejects.toThrow();
    await expect(connected(connect(url, 'a1', 'https://evil.example'))).rejects.toThrow();
    await expect(connected(connect(url, 'a1', 'https://app.example.com.evil.example'))).rejects.toThrow();
    await connected(connect(url, 'a1'));
  });

  it('uses organization-scoped rooms (organizations:{organizationId})', async () => {
    const { io, url } = await start();
    const a1 = connect(url, 'a1');
    await connected(a1);
    expect(await a1.emitWithAck('meeting:join', { meetingId: 'mA' })).toEqual({ ok: true });
    const rooms = [...(io.sockets.sockets.values().next().value?.rooms ?? [])];
    expect(rooms).toEqual(expect.arrayContaining(['organizations:orgA', 'organizations:orgA:meetings:mA']));
    expect(rooms).not.toContain('meeting:mA');
    expect(rooms.some((r) => r.startsWith('org:'))).toBe(false);
  });

  it('rejects missing and invalid tokens', async () => {
    const { url } = await start();
    await expect(connected(connect(url))).rejects.toThrow('unauthorized');
    await expect(connected(connect(url, 'nope'))).rejects.toThrow('unauthorized');
  });

  it('rejects when the verifier throws', async () => {
    const { app } = await createRealtimeServer({
      config: loadRealtimeConfig({ REALTIME_CORS_ORIGINS: ORIGIN }),
      verifySession: () => {
        throw new Error('boom');
      },
      canAccessMeeting: () => true
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    cleanups.push(() => app.close());
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    await expect(connected(connect(url, 'a1'))).rejects.toThrow('unauthorized');
  });

  it('scopes org and meeting rooms', async () => {
    const { io, url } = await start();
    const a1 = connect(url, 'a1');
    const a2 = connect(url, 'a2');
    const b1 = connect(url, 'b1');
    await Promise.all([connected(a1), connected(a2), connected(b1)]);

    expect(await a1.emitWithAck('meeting:join', { meetingId: 'mA' })).toEqual({ ok: true });
    expect(await b1.emitWithAck('meeting:join', { meetingId: 'mA' })).toEqual({ ok: false, error: 'forbidden' });
    expect(await b1.emitWithAck('meeting:join', { meetingId: '../x' })).toEqual({ ok: false, error: 'invalid' });

    const ev: MeetingStatusEvent = { meetingId: 'mA', organizationId: 'orgA', status: 'processing', at: new Date().toISOString() };
    const [ra1, ra2, rb1] = [nextEvent(a1, 'meeting:status'), nextEvent(a2, 'meeting:status'), nextEvent(b1, 'meeting:status')];
    emitToMeeting(io, 'orgA', 'mA', 'meeting:status', ev);
    expect(await ra1).toEqual(ev);
    expect(await ra2).toBe('timeout');
    expect(await rb1).toBe('timeout');

    const task = { taskId: 't1', organizationId: 'orgA', status: 'todo' as const, at: ev.at };
    const [ta1, ta2, tb1] = [nextEvent(a1, 'task:update'), nextEvent(a2, 'task:update'), nextEvent(b1, 'task:update')];
    emitToOrg(io, 'orgA', 'task:update', task);
    expect(await ta1).toEqual(task);
    expect(await ta2).toEqual(task);
    expect(await tb1).toBe('timeout');

    expect(await a1.emitWithAck('meeting:leave', { meetingId: 'mA' })).toEqual({ ok: true });
    const after = nextEvent(a1, 'meeting:status');
    emitToMeeting(io, 'orgA', 'mA', 'meeting:status', ev);
    expect(await after).toBe('timeout');
  });
});
