import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import {
  createRealtimeServer,
  emitProcessingStatus,
  emitUploadStatus,
  isProcessingStatusEvent,
  isUploadStatusEvent,
  loadRealtimeConfig,
  type ClientToServerEvents,
  type ProcessingStatusEvent,
  type RealtimeServerToClientEvents,
  type UploadStatusEvent
} from '../src/index.js';

type C = ClientSocket<RealtimeServerToClientEvents, ClientToServerEvents>;
const TOKENS: Record<string, { userId: string; organizationId: string }> = {
  a1: { userId: 'u1', organizationId: 'orgA' },
  b1: { userId: 'u3', organizationId: 'orgB' }
};
const ORIGIN = 'https://app.example.com';
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function start() {
  const { app, io } = await createRealtimeServer({
    config: loadRealtimeConfig({ REALTIME_PORT: '0', REALTIME_CORS_ORIGINS: ORIGIN }),
    verifySession: ({ token }) => (token ? (TOKENS[token] ?? null) : null),
    canAccessMeeting: ({ organizationId, meetingId }) => ({ mA: 'orgA', mB: 'orgB' })[meetingId] === organizationId
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  cleanups.push(() => app.close());
  return { io, url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
}
function connect(url: string, token?: string): C {
  const s: C = ioc(url, { auth: token ? { token } : {}, transports: ['websocket'], reconnection: false, forceNew: true, extraHeaders: { origin: ORIGIN } });
  cleanups.push(() => void s.disconnect());
  return s;
}
const connected = (s: C) => new Promise<void>((res, rej) => (s.once('connect', () => res()), s.once('connect_error', rej)));
function collect<E extends keyof RealtimeServerToClientEvents>(s: C, e: E) {
  const got: unknown[] = [];
  s.on(e, ((p: unknown) => got.push(p)) as never);
  return got;
}
const settle = () => new Promise((r) => setTimeout(r, 200));

const at = '2026-10-24T08:00:00.000Z';
const upload: UploadStatusEvent = { organizationId: 'orgA', meetingId: 'mA', uploadId: 'up1', status: 'verified', sha256: 'a'.repeat(64), sizeBytes: 3, at };
const processing: ProcessingStatusEvent = { organizationId: 'orgA', meetingId: 'mA', recordingId: 'r1', status: 'normalizing', percent: 5, at };

describe('media status events over Socket.IO', () => {
  it('rejects unauthenticated handshakes', async () => {
    const { url } = await start();
    await expect(connected(connect(url))).rejects.toThrow('unauthorized');
  });

  it('delivers upload:status and processing:status only to the owning organization, once per socket', async () => {
    const { io, url } = await start();
    const a1 = connect(url, 'a1');
    const b1 = connect(url, 'b1');
    await Promise.all([connected(a1), connected(b1)]);
    expect(await a1.emitWithAck('meeting:join', { meetingId: 'mA' })).toEqual({ ok: true }); // in org + meeting room
    const [ua, ub, pa, pb] = [collect(a1, 'upload:status'), collect(b1, 'upload:status'), collect(a1, 'processing:status'), collect(b1, 'processing:status')];
    emitUploadStatus(io, upload);
    emitProcessingStatus(io, processing);
    await settle();
    expect(ua).toEqual([upload]);
    expect(pa).toEqual([processing]);
    expect(ub).toEqual([]);
    expect(pb).toEqual([]);
  });

  it('refuses to broadcast malformed or over-broad payloads', async () => {
    const { io } = await start();
    expect(() => emitUploadStatus(io, { ...upload, key: 'organizations/orgA/x' } as never)).toThrow(TypeError);
    expect(() => emitUploadStatus(io, { ...upload, status: 'done' as never })).toThrow(TypeError);
    expect(() => emitUploadStatus(io, { ...upload, sha256: 'XYZ' })).toThrow(TypeError);
    expect(() => emitProcessingStatus(io, { ...processing, percent: 101 })).toThrow(TypeError);
    expect(() => emitProcessingStatus(io, { ...processing, organizationId: '../b' })).toThrow(TypeError);
    expect(() => emitProcessingStatus(io, { ...processing, errorCode: 'Error: /tmp/x' })).toThrow(TypeError);
  });

  it('type guards accept the documented shapes', () => {
    expect(isUploadStatusEvent({ organizationId: 'o', meetingId: 'm', uploadId: 'u', status: 'failed', errorCode: 'checksum_mismatch', at })).toBe(true);
    expect(isProcessingStatusEvent({ organizationId: 'o', meetingId: 'm', recordingId: 'r', status: 'completed', at })).toBe(true);
  });
});
