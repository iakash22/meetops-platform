import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import {
  createRealtimeServer,
  emitToMeeting,
  emitToOrg,
  loadRealtimeConfig,
  type ClientToServerEvents,
  type ServerToClientEvents,
  type MeetingStatusEvent
} from '../src/index.js';

type C = ClientSocket<ServerToClientEvents, ClientToServerEvents>;
const TOKENS: Record<string, { userId: string; orgId: string }> = {
  a1: { userId: 'u1', orgId: 'orgA' },
  a2: { userId: 'u2', orgId: 'orgA' },
  b1: { userId: 'u3', orgId: 'orgB' }
};
const MEETINGS: Record<string, string> = { mA: 'orgA', mB: 'orgB' };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function start() {
  const { app, io } = await createRealtimeServer({
    config: loadRealtimeConfig({ REALTIME_PORT: '0' }),
    verifySession: ({ token }) => (token ? (TOKENS[token] ?? null) : null),
    canAccessMeeting: ({ orgId, meetingId }) => MEETINGS[meetingId] === orgId
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  cleanups.push(() => app.close());
  const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  return { app, io, url };
}

function connect(url: string, token?: string): C {
  const s: C = ioc(url, { auth: token ? { token } : {}, transports: ['websocket'], reconnection: false, forceNew: true });
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

describe('config', () => {
  it('parses env', () => {
    expect(loadRealtimeConfig({})).toMatchObject({ port: 4001, corsOrigins: '*', path: '/socket.io' });
    expect(loadRealtimeConfig({ REDIS_URL: 'redis://x', REALTIME_CORS_ORIGINS: 'http://a, http://b' })).toMatchObject({
      redisUrl: 'redis://x',
      corsOrigins: ['http://a', 'http://b']
    });
    expect(() => loadRealtimeConfig({ REALTIME_PORT: 'abc' })).toThrow();
  });
});

describe('realtime server', () => {
  it('GET /health', async () => {
    const { app } = await start();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', adapter: 'memory' });
  });

  it('rejects missing and invalid tokens', async () => {
    const { url } = await start();
    await expect(connected(connect(url))).rejects.toThrow('unauthorized');
    await expect(connected(connect(url, 'nope'))).rejects.toThrow('unauthorized');
  });

  it('rejects when the verifier throws', async () => {
    const { app } = await createRealtimeServer({
      config: loadRealtimeConfig({}),
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

    const ev: MeetingStatusEvent = { meetingId: 'mA', orgId: 'orgA', status: 'processing', at: new Date().toISOString() };
    const [ra1, ra2, rb1] = [nextEvent(a1, 'meeting:status'), nextEvent(a2, 'meeting:status'), nextEvent(b1, 'meeting:status')];
    emitToMeeting(io, 'mA', 'meeting:status', ev);
    expect(await ra1).toEqual(ev);
    expect(await ra2).toBe('timeout');
    expect(await rb1).toBe('timeout');

    const task = { taskId: 't1', orgId: 'orgA', status: 'open' as const, at: ev.at };
    const [ta1, ta2, tb1] = [nextEvent(a1, 'task:update'), nextEvent(a2, 'task:update'), nextEvent(b1, 'task:update')];
    emitToOrg(io, 'orgA', 'task:update', task);
    expect(await ta1).toEqual(task);
    expect(await ta2).toEqual(task);
    expect(await tb1).toBe('timeout');

    expect(await a1.emitWithAck('meeting:leave', { meetingId: 'mA' })).toEqual({ ok: true });
    const after = nextEvent(a1, 'meeting:status');
    emitToMeeting(io, 'mA', 'meeting:status', ev);
    expect(await after).toBe('timeout');
  });
});
