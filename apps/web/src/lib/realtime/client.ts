import { backoffDelay, DEFAULT_BACKOFF, type BackoffOptions } from './backoff';
import { buildSocketUrl, decodePacket, encode } from './protocol';

export type RealtimeStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'stopped';

/** Why the client stopped for good (it will not reconnect on its own). */
export type StopReason =
  | 'closed'
  | 'session_revoked'
  | 'member_removed'
  | 'unauthorized'
  /** The upgrade kept closing before it opened (Origin check, 401/403 on the upgrade, a proxy without WebSocket support). */
  | 'transport_rejected';

export type RealtimeEventHandler = (name: string, payload: unknown) => void;

type WebSocketLike = {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
};
export type WebSocketFactory = (url: string) => WebSocketLike;

export type RealtimeClientOptions = {
  /** Realtime origin, e.g. https://rt.example.com. Defaults to the page origin. */
  url?: string | undefined;
  /** Socket.IO path on the server (REALTIME_SOCKET_PATH). */
  path?: string;
  onEvent: RealtimeEventHandler;
  onStatus?: (status: RealtimeStatus, stopReason?: StopReason) => void;
  /** Injected for tests. */
  createSocket?: WebSocketFactory | undefined;
  origin?: string;
  backoff?: BackoffOptions;
  random?: () => number;
  /** Give up after this many consecutive `unauthorized` connect errors (avoid hammering the rate limiter). */
  maxAuthFailures?: number;
  /** Give up after this many consecutive upgrades that close or error before the socket opens. */
  maxTransportFailures?: number;
  /**
   * Called when the `unauthorized` cap is hit. Resolves true when the HTTP session is still valid, in which case
   * the client restarts (fresh counters) instead of stopping. Without it the client stops with 'unauthorized'.
   */
  checkSession?: (() => Promise<boolean>) | undefined;
  /** Session re-checks that may restart the client in a row (no successful connect in between). */
  maxSessionRechecks?: number;
  /** Fail the attempt if the Socket.IO connect does not complete in time. */
  connectTimeoutMs?: number;
};

const OPEN = 1;
const CONTROL_EVENTS = new Set(['session:revoked', 'org:access-changed', 'auth:reauth-required']);

/**
 * Native-WebSocket client for apps/realtime (Socket.IO 4 server, websocket transport only).
 *
 * Auth: the browser sends the HttpOnly session cookie on the upgrade request; nothing else is sent
 * (no token in `auth`, no extra query keys), matching ADR-011 section 1.1. Cookie sockets are joined to
 * their organization room by the server, so no client join is needed for org fan-out.
 *
 * Lifecycle: exponential backoff with jitter on any drop; a heartbeat watchdog reconnects when the
 * server's pings stop; `session:revoked` and `org:access-changed{member_removed}` stop it for good;
 * `auth:reauth-required` and `role_changed` reconnect. `stop()` clears every timer and handler.
 */
export class RealtimeClient {
  private ws: WebSocketLike | null = null;
  private status: RealtimeStatus = 'idle';
  private attempt = 0;
  private authFailures = 0;
  private transportFailures = 0;
  private sessionRechecks = 0;
  /** Bumped on every start/stop so a late checkSession() result for an old run is ignored. */
  private run = 0;
  /** True once the current socket delivered its Engine.IO open packet (the upgrade succeeded). */
  private opened = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  private connectTimer: ReturnType<typeof setTimeout> | undefined;
  private heartbeatMs = 45_000;
  private readonly opts: RealtimeClientOptions;

  constructor(opts: RealtimeClientOptions) {
    this.opts = opts;
  }

  getStatus(): RealtimeStatus {
    return this.status;
  }

  start(): void {
    if (this.status === 'connecting' || this.status === 'connected') return;
    this.run += 1;
    this.attempt = 0;
    this.authFailures = 0;
    this.transportFailures = 0;
    this.sessionRechecks = 0;
    this.open();
  }

  stop(reason: StopReason = 'closed'): void {
    this.run += 1;
    this.clearTimers();
    this.teardownSocket(true);
    this.setStatus('stopped', reason);
  }

  private setStatus(s: RealtimeStatus, reason?: StopReason) {
    if (this.status === s && s !== 'stopped') return;
    this.status = s;
    this.opts.onStatus?.(s, reason);
  }

  private clearTimers() {
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.heartbeatTimer);
    clearTimeout(this.connectTimer);
    this.reconnectTimer = this.heartbeatTimer = this.connectTimer = undefined;
  }

  private teardownSocket(sayGoodbye: boolean) {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try {
      if (sayGoodbye && ws.readyState === OPEN) ws.send(encode.disconnect());
      ws.close(1000);
    } catch {
      /* already closed */
    }
  }

  private open() {
    this.clearTimers();
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');
    const origin = this.opts.origin ?? globalThis.location?.origin ?? 'http://localhost';
    let ws: WebSocketLike;
    try {
      const url = buildSocketUrl(this.opts.url ?? '', this.opts.path ?? '/socket.io', origin);
      ws = (this.opts.createSocket ?? ((u) => new WebSocket(u) as unknown as WebSocketLike))(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.opened = false;
    this.connectTimer = setTimeout(() => this.drop(), this.opts.connectTimeoutMs ?? 20_000);
    ws.onmessage = (ev) => this.onFrame(ev.data);
    ws.onopen = () => {
      this.opened = true;
    };
    ws.onclose = () => this.transportLost();
    ws.onerror = () => this.transportLost();
  }

  /** close/error from the socket: before open it is a rejected upgrade and counts toward the cap. */
  private transportLost() {
    if (this.status === 'stopped') return;
    if (!this.opened) {
      this.transportFailures += 1;
      if (this.transportFailures >= (this.opts.maxTransportFailures ?? 3))
        return this.stop('transport_rejected');
    }
    this.drop();
  }

  /** The `unauthorized` cap was hit: re-check the HTTP session before giving up for good. */
  private onAuthCap() {
    const check = this.opts.checkSession;
    if (!check || this.sessionRechecks >= (this.opts.maxSessionRechecks ?? 3))
      return this.stop('unauthorized');
    this.sessionRechecks += 1;
    this.teardownSocket(false);
    this.clearTimers();
    this.setStatus('reconnecting');
    const run = this.run;
    void check()
      .catch(() => false)
      .then((valid) => {
        if (run !== this.run || this.status === 'stopped') return;
        if (!valid) return this.stop('unauthorized');
        this.authFailures = 0;
        this.transportFailures = 0;
        this.scheduleReconnect();
      });
  }

  /** The transport went away (or is unhealthy): close it and retry with backoff. */
  private drop() {
    if (this.status === 'stopped') return;
    this.teardownSocket(false);
    this.scheduleReconnect();
  }

  private scheduleReconnect() {
    this.clearTimers();
    if (this.status === 'stopped') return;
    this.setStatus('reconnecting');
    const delay = backoffDelay(
      this.attempt,
      this.opts.backoff ?? DEFAULT_BACKOFF,
      this.opts.random,
    );
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }

  private armHeartbeat() {
    clearTimeout(this.heartbeatTimer);
    this.heartbeatTimer = setTimeout(() => this.drop(), this.heartbeatMs);
  }

  private onFrame(data: unknown) {
    const p = decodePacket(data);
    switch (p.type) {
      case 'open':
        this.opened = true;
        this.heartbeatMs = p.data.pingInterval + p.data.pingTimeout;
        this.armHeartbeat();
        this.ws?.send(encode.connect());
        return;
      case 'ping':
        this.armHeartbeat();
        this.ws?.send(encode.pong());
        return;
      case 'connect':
        clearTimeout(this.connectTimer);
        this.attempt = 0;
        this.authFailures = 0;
        this.transportFailures = 0;
        this.sessionRechecks = 0;
        this.armHeartbeat();
        this.setStatus('connected');
        return;
      case 'connect_error':
        this.authFailures += 1;
        if (this.authFailures >= (this.opts.maxAuthFailures ?? 3)) return this.onAuthCap();
        return this.drop();
      case 'disconnect':
      case 'close':
        return this.drop();
      case 'event':
        this.armHeartbeat();
        if (CONTROL_EVENTS.has(p.name)) return this.onControl(p.name, p.payload);
        this.safeDispatch(p.name, p.payload);
        return;
      default:
        return;
    }
  }

  private onControl(name: string, payload: unknown) {
    this.safeDispatch(name, payload);
    if (name === 'session:revoked') return this.stop('session_revoked');
    if (name === 'org:access-changed') {
      const reason = (payload as { reason?: unknown } | null)?.reason;
      if (reason === 'member_removed') return this.stop('member_removed');
    }
    // auth:reauth-required / role_changed: the server disconnects next; the backoff reconnect picks up the new session.
  }

  private safeDispatch(name: string, payload: unknown) {
    try {
      this.opts.onEvent(name, payload);
    } catch {
      /* a bad handler must not kill the connection */
    }
  }
}
