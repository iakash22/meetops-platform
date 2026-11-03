/**
 * Minimal Engine.IO v4 / Socket.IO v5 framing over a native WebSocket, enough for the apps/realtime server
 * (Socket.IO 4, default namespace, server-to-client events only). No `socket.io-client` dependency.
 *
 * Engine.IO packets: `0` open (JSON handshake), `1` close, `2` ping, `3` pong, `4` message.
 * Socket.IO packets ride inside `4`: `40` connect, `41` disconnect, `42` event, `44` connect error.
 */
export const ENGINE_IO_VERSION = '4';

export type EngineOpen = { sid: string; pingInterval: number; pingTimeout: number };

export type Packet =
  | { type: 'open'; data: EngineOpen }
  | { type: 'close' }
  | { type: 'ping' }
  | { type: 'connect' }
  | { type: 'disconnect' }
  | { type: 'connect_error'; message: string }
  | { type: 'event'; name: string; payload: unknown }
  | { type: 'unknown' };

const UNKNOWN: Packet = { type: 'unknown' };

function parseJson(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return undefined;
  }
}

/** Decode one text frame. Binary frames, other namespaces and acks are reported as `unknown` and ignored. */
export function decodePacket(frame: unknown): Packet {
  if (typeof frame !== 'string' || frame.length === 0) return UNKNOWN;
  switch (frame[0]) {
    case '0': {
      const d = parseJson(frame.slice(1)) as Partial<EngineOpen> | undefined;
      if (!d || typeof d.sid !== 'string') return UNKNOWN;
      const num = (v: unknown, dflt: number) =>
        typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : dflt;
      return {
        type: 'open',
        data: {
          sid: d.sid,
          pingInterval: num(d.pingInterval, 25_000),
          pingTimeout: num(d.pingTimeout, 20_000),
        },
      };
    }
    case '1':
      return { type: 'close' };
    case '2':
      return { type: 'ping' };
    case '4':
      return decodeSocketPacket(frame.slice(1));
    default:
      return UNKNOWN;
  }
}

function decodeSocketPacket(s: string): Packet {
  const kind = s[0];
  let rest = s.slice(1);
  // Only the default namespace is used; `/other,` prefixes are ignored.
  if (rest.startsWith('/')) return UNKNOWN;
  if (kind === '0') return { type: 'connect' };
  if (kind === '1') return { type: 'disconnect' };
  if (kind === '4') {
    const d = parseJson(rest) as { message?: unknown } | undefined;
    return { type: 'connect_error', message: typeof d?.message === 'string' ? d.message : 'error' };
  }
  if (kind === '2') {
    // Optional ack id before the JSON array; server-to-client acks are not used by this server.
    rest = rest.replace(/^\d+/, '');
    const arr = parseJson(rest);
    if (!Array.isArray(arr) || typeof arr[0] !== 'string') return UNKNOWN;
    return { type: 'event', name: arr[0], payload: arr[1] };
  }
  return UNKNOWN;
}

export const encode = {
  pong: () => '3',
  /**
   * Socket.IO connect to `/` with no `auth`. Web sockets authenticate with the session cookie only;
   * the server rejects a web handshake that carries `auth.token` (ADR-011 section 1.1).
   */
  connect: () => '40',
  disconnect: () => '41',
};

/**
 * Build the websocket URL. Only the Engine.IO query keys are sent: the server rejects any other query key
 * (ADR-011 section 1.2), so credentials can never ride in the URL.
 */
export function buildSocketUrl(base: string, path: string, origin: string): string {
  const u = new URL(base || origin, origin);
  if (u.protocol === 'http:') u.protocol = 'ws:';
  else if (u.protocol === 'https:') u.protocol = 'wss:';
  if (u.protocol !== 'ws:' && u.protocol !== 'wss:')
    throw new Error('realtime url must be http(s) or ws(s)');
  const p = (path || '/socket.io').replace(/\/+$/, '');
  u.pathname = `${p}/`;
  u.search = `?EIO=${ENGINE_IO_VERSION}&transport=websocket`;
  u.hash = '';
  u.username = '';
  u.password = '';
  return u.toString();
}
