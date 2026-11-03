import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeClient, type RealtimeStatus } from '@/lib/realtime/client';
import { backoffDelay } from '@/lib/realtime/backoff';
import { buildSocketUrl, decodePacket } from '@/lib/realtime/protocol';
import { isRealtimeEnabled, warnIfCrossHost } from '@/lib/realtime/flag';

export class FakeSocket {
  static all: FakeSocket[] = [];
  readyState = 1;
  sent: string[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.all.push(this);
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  recv(frame: string) {
    this.onmessage?.({ data: frame });
  }
  handshake() {
    this.recv(
      '0{"sid":"s1","pingInterval":25000,"pingTimeout":20000,"upgrades":[],"maxPayload":1000000}',
    );
    this.recv('40{"sid":"x"}');
  }
}
const last = () => FakeSocket.all[FakeSocket.all.length - 1]!;

function make(extra: Partial<ConstructorParameters<typeof RealtimeClient>[0]> = {}) {
  const events: Array<[string, unknown]> = [];
  const statuses: RealtimeStatus[] = [];
  const client = new RealtimeClient({
    url: 'https://rt.example.com',
    origin: 'https://app.example.com',
    createSocket: (u) => new FakeSocket(u),
    random: () => 1,
    onEvent: (n, p) => events.push([n, p]),
    onStatus: (s) => statuses.push(s),
    ...extra,
  });
  return { client, events, statuses };
}

beforeEach(() => {
  FakeSocket.all = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe('protocol', () => {
  it('builds a ws(s) url with only Engine.IO query keys (no credentials)', () => {
    expect(
      buildSocketUrl('https://u:p@rt.example.com/x?token=1#h', '/socket.io', 'https://a'),
    ).toBe('wss://rt.example.com/socket.io/?EIO=4&transport=websocket');
    expect(buildSocketUrl('', '/rt/', 'http://localhost:5173')).toBe(
      'ws://localhost:5173/rt/?EIO=4&transport=websocket',
    );
    expect(() => buildSocketUrl('javascript:alert(1)', '/socket.io', 'https://a')).toThrow();
  });

  it('decodes events, errors and ignores junk', () => {
    expect(decodePacket('42["task:update",{"a":1}]')).toEqual({
      type: 'event',
      name: 'task:update',
      payload: { a: 1 },
    });
    expect(decodePacket('4212["x",1]')).toMatchObject({ type: 'event', name: 'x' });
    expect(decodePacket('44{"message":"unauthorized"}')).toEqual({
      type: 'connect_error',
      message: 'unauthorized',
    });
    expect(decodePacket('42/admin,["x"]').type).toBe('unknown');
    expect(decodePacket('42{bad').type).toBe('unknown');
    expect(decodePacket(new ArrayBuffer(2)).type).toBe('unknown');
  });

  it('backoff grows exponentially and is capped', () => {
    const r = () => 1;
    expect([0, 1, 2, 3, 10].map((a) => backoffDelay(a, undefined, r))).toEqual([
      1000, 2000, 4000, 8000, 30000,
    ]);
    expect(backoffDelay(0, undefined, () => 0)).toBe(500);
  });

  it('feature flag is off unless exactly "true"', () => {
    expect(isRealtimeEnabled({} as ImportMetaEnv)).toBe(false);
    expect(isRealtimeEnabled({ VITE_REALTIME_ENABLED: '1' } as ImportMetaEnv)).toBe(false);
    expect(isRealtimeEnabled({ VITE_REALTIME_ENABLED: 'true' } as ImportMetaEnv)).toBe(true);
  });
});

describe('RealtimeClient', () => {
  it('connects with a bare Socket.IO connect (cookie auth, no token) and answers pings', () => {
    const { client, statuses, events } = make();
    client.start();
    const ws = last();
    expect(ws.url).toBe('wss://rt.example.com/socket.io/?EIO=4&transport=websocket');
    ws.handshake();
    expect(ws.sent).toEqual(['40']);
    expect(statuses).toEqual(['connecting', 'connected']);
    ws.recv('2');
    expect(ws.sent).toContain('3');
    ws.recv('42["task:update",{"taskId":"t"}]');
    expect(events).toEqual([['task:update', { taskId: 't' }]]);
  });

  it('reconnects with backoff after a drop and resets the attempt on success', () => {
    const { client, statuses } = make();
    client.start();
    last().handshake();
    last().onclose?.({});
    expect(statuses.at(-1)).toBe('reconnecting');
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(FakeSocket.all).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(2);
    last().onerror?.({});
    vi.advanceTimersByTime(1999);
    expect(FakeSocket.all).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(3);
    last().handshake();
    expect(statuses.at(-1)).toBe('connected');
    last().onclose?.({});
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(4);
  });

  it('reconnects when the server heartbeat stops', () => {
    const { client } = make();
    client.start();
    last().handshake();
    vi.advanceTimersByTime(45_000);
    expect(FakeSocket.all[0]!.closed).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('times out a handshake that never completes', () => {
    const { client } = make({ connectTimeoutMs: 5000 });
    client.start();
    vi.advanceTimersByTime(5000);
    expect(FakeSocket.all[0]!.closed).toBe(true);
  });

  it('stops after repeated unauthorized connect errors', () => {
    const { client, statuses } = make({ maxAuthFailures: 2 });
    client.start();
    last().recv('44{"message":"unauthorized"}');
    vi.advanceTimersByTime(1000);
    last().recv('44{"message":"unauthorized"}');
    expect(client.getStatus()).toBe('stopped');
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.all).toHaveLength(2);
    expect(statuses.at(-1)).toBe('stopped');
  });

  it('M1: rejected upgrades never stop the client; past the cap it retries about every 5 minutes', () => {
    const statuses: Array<[string, string | undefined]> = [];
    const { client } = make({ onStatus: (st, r) => statuses.push([st, r]) });
    client.start();
    last().onclose?.({}); // e.g. 502 / Origin rejected: closes without ever opening
    vi.advanceTimersByTime(1000);
    last().onerror?.({});
    vi.advanceTimersByTime(2000);
    last().onclose?.({}); // 3rd: cap hit, slow mode
    expect(client.getStatus()).toBe('reconnecting');
    vi.advanceTimersByTime(299_999);
    expect(FakeSocket.all).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.all).toHaveLength(4);
    last().onclose?.({});
    vi.advanceTimersByTime(300_000);
    expect(FakeSocket.all).toHaveLength(5);
    last().handshake();
    expect(client.getStatus()).toBe('connected');
    expect(statuses.some(([st]) => st === 'stopped')).toBe(false);
    // A connect resets to fast backoff.
    last().onclose?.({});
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(6);
  });

  it('M1: drops after a successful open do not count toward the cap', () => {
    const { client } = make({ maxTransportFailures: 2 });
    client.start();
    last().onclose?.({}); // 1 rejected
    vi.advanceTimersByTime(1000);
    last().recv('0{"sid":"s","pingInterval":25000,"pingTimeout":20000}');
    last().onclose?.({}); // opened, then dropped: not a rejection
    vi.advanceTimersByTime(2000);
    expect(FakeSocket.all).toHaveLength(3);
    last().onclose?.({}); // 2 rejected: slow mode
    vi.advanceTimersByTime(8000);
    expect(FakeSocket.all).toHaveLength(3);
  });

  it('M1: online and visibilitychange to visible reset the backoff and retry now', () => {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState: 'hidden' });
    const { client } = make({ windowTarget: win, documentTarget: doc });
    client.start();
    for (let i = 0; i < 3; i++) {
      last().onclose?.({});
      vi.advanceTimersByTime(4000);
    }
    expect(FakeSocket.all).toHaveLength(3); // slow mode
    win.dispatchEvent(new Event('online'));
    // hidden tab: no retry on online either
    expect(FakeSocket.all).toHaveLength(3);
    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(FakeSocket.all).toHaveLength(4);
    last().onclose?.({}); // backoff was reset: back to the fast 1s retry
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(5);
    last().handshake();
    win.dispatchEvent(new Event('online')); // connected: ignored
    expect(FakeSocket.all).toHaveLength(5);
    client.stop();
    win.dispatchEvent(new Event('online')); // listeners removed
    doc.dispatchEvent(new Event('visibilitychange'));
    expect(FakeSocket.all).toHaveLength(5);
  });

  it('L2: at the unauthorized cap a still-valid session restarts instead of stopping', async () => {
    const checkSession = vi.fn().mockResolvedValue(true);
    const { client } = make({ maxAuthFailures: 2, checkSession, connectTimeoutMs: 1e9 });
    client.start();
    last().recv('44{"message":"unauthorized"}');
    vi.advanceTimersByTime(1000);
    last().recv('44{"message":"unauthorized"}');
    expect(checkSession).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getStatus()).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeSocket.all).toHaveLength(3);
    last().handshake();
    expect(client.getStatus()).toBe('connected');
  });

  it('L2: stops when the session is gone, or after too many re-checks', async () => {
    const gone = make({ maxAuthFailures: 1, checkSession: () => Promise.resolve(false) });
    gone.client.start();
    last().recv('44{"message":"unauthorized"}');
    await vi.advanceTimersByTimeAsync(0);
    expect(gone.client.getStatus()).toBe('stopped');

    FakeSocket.all = [];
    const checkSession = vi.fn().mockResolvedValue(true);
    const loop = make({
      maxAuthFailures: 1,
      maxSessionRechecks: 2,
      checkSession,
      connectTimeoutMs: 1e9,
    });
    loop.client.start();
    for (let i = 0; i < 3; i++) {
      last().recv('44{"message":"unauthorized"}');
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(checkSession).toHaveBeenCalledTimes(2);
    expect(loop.client.getStatus()).toBe('stopped');
  });

  it('L2: a session check that resolves after stop() does not restart', async () => {
    let resolve!: (v: boolean) => void;
    const { client } = make({
      maxAuthFailures: 1,
      checkSession: () => new Promise<boolean>((r) => (resolve = r)),
    });
    client.start();
    last().recv('44{"message":"unauthorized"}');
    client.stop();
    resolve(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all).toHaveLength(1);
    expect(client.getStatus()).toBe('stopped');
  });

  it('L1: warns when VITE_REALTIME_URL is on another host than the page', () => {
    const warn = vi.fn();
    expect(warnIfCrossHost('https://rt.example.com', 'app.example.com', warn)).toBe(true);
    expect(warn.mock.calls[0]![0]).toMatch(/rt\.example\.com.*app\.example\.com/);
    expect(warnIfCrossHost('https://app.example.com/x', 'app.example.com', warn)).toBe(false);
    expect(warnIfCrossHost(undefined, 'app.example.com', warn)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('never reconnects after session:revoked or member_removed', () => {
    for (const frame of [
      '42["session:revoked",{"reason":"logout","at":"2026-11-03T00:00:00Z"}]',
      '42["org:access-changed",{"organizationId":"o","reason":"member_removed","at":"2026-11-03T00:00:00Z"}]',
    ]) {
      FakeSocket.all = [];
      const { client } = make();
      client.start();
      last().handshake();
      last().recv(frame);
      expect(client.getStatus()).toBe('stopped');
      vi.advanceTimersByTime(120_000);
      expect(FakeSocket.all).toHaveLength(1);
    }
  });

  it('reconnects after auth:reauth-required', () => {
    const { client } = make();
    client.start();
    last().handshake();
    last().recv('42["auth:reauth-required",{"reason":"org_switch","at":"2026-11-03T00:00:00Z"}]');
    last().recv('41');
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.all).toHaveLength(2);
  });

  it('stop() closes the socket, detaches handlers and clears timers', () => {
    const { client } = make();
    client.start();
    const ws = last();
    ws.handshake();
    client.stop();
    expect(ws.closed).toBe(true);
    expect(ws.sent.at(-1)).toBe('41');
    expect(ws.onmessage).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a throwing handler does not break the connection', () => {
    const { client } = make({
      onEvent: () => {
        throw new Error('boom');
      },
    });
    client.start();
    last().handshake();
    last().recv('42["task:update",{}]');
    expect(client.getStatus()).toBe('connected');
  });
});
