import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { Server, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { REDACT_KEYS } from '@meetops/contracts';
import { resolveClientIp, resolveForwardedIp, type TrustProxyFn } from '@meetops/config';
import { createLogger, type Logger } from '@meetops/logger';
import type { RealtimeConfig } from './config.js';
import { installSecurityHeaders } from './security-headers.js';
import { REALTIME_CONTROL_EVENTS, type ReauthReason } from './control-events.js';
import {
  classifyOrigin,
  readHandshakeCredential,
  type ClientKind,
  type HandshakePolicy,
  type RealtimeCredential,
} from './handshake.js';
import {
  MEDIA_EVENTS,
  MEETING_ID_PATTERN,
  REALTIME_CONNECT_ERROR,
  isProcessingStatusEvent,
  isUploadStatusEvent,
  meetingRoom,
  organizationRoom,
  userRoom,
  type ClientToServerEvents,
  type InterServerEvents,
  type MeetingAccessInput,
  type ProcessingStatusEvent,
  type RealtimeServerToClientEvents as ServerToClientEvents,
  type SocketData,
  type UploadStatusEvent,
} from './events.js';

/**
 * Layerbase routes every database through TLS port 6379 and reads the database from the SNI hostname.
 * node-redis does not send that hostname for a bare rediss:// URL.
 */
function createRealtimeRedis(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'rediss:') return createClient({ url });
  return createClient({
    username: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    socket: {
      host: parsed.hostname,
      port: parsed.port ? Number(parsed.port) : 6379,
      tls: true,
      servername: parsed.hostname,
    },
  });
}

/** What the verifier returns (a structural subset of @meetops/session-verifier's VerifiedSession). */
export type AuthContext = {
  userId: string;
  organizationId: string;
  sessionId: string;
  credential: 'session' | 'extension' | 'desktop';
  scopes?: readonly string[];
  expiresAt: Date;
};

/**
 * Verifies the one credential read from the handshake (ADR-011 section 1). main() passes
 * @meetops/session-verifier's verifySession; tests pass a fake. Return null or throw to reject.
 */
export type SessionVerifier = (
  credential: RealtimeCredential,
) => Promise<AuthContext | null> | AuthContext | null;

/** Decide whether the socket's org may access a meeting (ADR-011 section 4.1). Throw = fail closed. */
export type MeetingAccessHook = (input: MeetingAccessInput) => Promise<boolean> | boolean;

export type RealtimeIo = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;
type RealtimeSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>;

export type RealtimeServerOptions = {
  config: RealtimeConfig;
  verifySession: SessionVerifier;
  canAccessMeeting: MeetingAccessHook;
  logger?: boolean;
  /** Injectable clock (tests). */
  now?: () => number;
  /**
   * ADR-011 section 3 revocation feed: register a listener for raw `meetops:auth:revocations` messages and return
   * an unsubscribe. Defaults to a Redis subscription when REDIS_URL is set; tests pass a fake.
   */
  /** Concurrent-socket counter; defaults to Redis when REDIS_URL is set, else in-memory. */
  concurrency?: ConcurrencyTracker;
  subscribeRevocations?: (
    listener: (raw: string) => void,
  ) => (() => Promise<void> | void) | Promise<() => Promise<void> | void>;
};

/**
 * Fixed-window counter keyed by IP, user or socket. In-process: each realtime replica enforces its own limit. The map
 * is a hard-capped LRU: expired entries are swept first, then the least recently used key is evicted, so a key flood
 * cannot grow memory without bound.
 */
export class ConnectionRateLimiter {
  private readonly hits = new Map<string, { n: number; resetAt: number }>();
  constructor(
    private readonly windowMs: number,
    private readonly now: () => number,
    private readonly maxKeys = 10_000,
  ) {}
  get size(): number {
    return this.hits.size;
  }
  /** Counts one attempt; false once `limit` is exceeded within the window. */
  take(key: string, limit: number): boolean {
    const t = this.now();
    const e = this.hits.get(key);
    if (e && e.resetAt > t) {
      // Re-insert to mark as most recently used.
      this.hits.delete(key);
      this.hits.set(key, e);
      e.n += 1;
      return e.n <= limit;
    }
    if (e) this.hits.delete(key);
    if (this.hits.size >= this.maxKeys) {
      for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
      while (this.hits.size >= this.maxKeys) {
        const oldest = this.hits.keys().next().value as string;
        this.hits.delete(oldest);
      }
    }
    this.hits.set(key, { n: 1, resetAt: t + this.windowMs });
    return true;
  }
}

/** Counts live sockets per key (user, IP). acquire() is false once `limit` sockets are already held. */
export type ConcurrencyTracker = {
  acquire(key: string, limit: number): Promise<boolean>;
  release(key: string): Promise<void>;
};

/** Fixed window after which a concurrency counter expires, so a lost release cannot hold a slot forever. */
export const CONCURRENCY_WINDOW_SECONDS = 3_600;

/**
 * In-process socket counts. Each key carries a fixed expiry set when it is created (never refreshed), and expired keys
 * are swept at most once per window, so a leaked slot frees itself and the map cannot grow without bound.
 */
export function createMemoryConcurrencyTracker(
  ttlMs = CONCURRENCY_WINDOW_SECONDS * 1000,
  now: () => number = Date.now,
): ConcurrencyTracker & { readonly size: number } {
  const counts = new Map<string, { n: number; expiresAt: number }>();
  let lastSweep = now();
  const sweep = (t: number) => {
    if (t - lastSweep < ttlMs) return;
    lastSweep = t;
    for (const [k, v] of counts) if (v.expiresAt <= t) counts.delete(k);
  };
  const live = (key: string, t: number) => {
    const e = counts.get(key);
    if (e && e.expiresAt <= t) {
      counts.delete(key);
      return undefined;
    }
    return e;
  };
  return {
    get size() {
      return counts.size;
    },
    async acquire(key, limit) {
      const t = now();
      sweep(t);
      const e = live(key, t);
      if ((e?.n ?? 0) >= limit) return false;
      if (e) e.n += 1;
      else counts.set(key, { n: 1, expiresAt: t + ttlMs });
      return true;
    },
    async release(key) {
      const t = now();
      sweep(t);
      const e = live(key, t);
      if (!e) return;
      e.n -= 1;
      if (e.n <= 0) counts.delete(key);
    },
  };
}

/** The node-redis EVAL shape (v4: `client.eval(script, { keys, arguments })`). */
export type RedisEval = {
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
};

/**
 * Atomic acquire: INCR, set the TTL only when the key is new (fixed window; EXPIRE ... NX semantics, never refreshed by
 * later attempts), and roll back over the cap. Returns 1 when acquired, 0 when over the cap.
 */
export const REDIS_ACQUIRE_SCRIPT = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2])) end
if n > tonumber(ARGV[1]) then
  if redis.call('DECR', KEYS[1]) <= 0 then redis.call('DEL', KEYS[1]) end
  return 0
end
return 1
`;
/** Atomic release: never lets a counter go negative (e.g. after its window expired) and drops it at zero. */
export const REDIS_RELEASE_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
local n = redis.call('DECR', KEYS[1])
if n <= 0 then redis.call('DEL', KEYS[1]) end
return n
`;

/**
 * Cluster-wide socket counts in Redis via Lua scripts (atomic). Each key expires a fixed `ttlSeconds` after it was
 * created, so slots leaked by a crashed replica are freed at the end of the window.
 */
export function createRedisConcurrencyTracker(
  redis: RedisEval,
  ttlSeconds = CONCURRENCY_WINDOW_SECONDS,
): ConcurrencyTracker {
  const k = (key: string) => `meetops:realtime:conns:${key}`;
  return {
    async acquire(key, limit) {
      const r = await redis.eval(REDIS_ACQUIRE_SCRIPT, {
        keys: [k(key)],
        arguments: [String(limit), String(ttlSeconds)],
      });
      return Number(r) === 1;
    },
    async release(key) {
      await redis.eval(REDIS_RELEASE_SCRIPT, { keys: [k(key)], arguments: [] });
    },
  };
}

/**
 * Client IP for the per-IP limits, resolved exactly like the API's ADR-014 client IP (shared @meetops/config helper):
 * X-Forwarded-For is honoured only when the socket peer is in the TRUST_PROXY allowlist, walked from the right while
 * hops are trusted; CF-Connecting-IP only with BEHIND_CLOUDFLARE=true from a pinned Cloudflare edge. `Forwarded` is
 * never read. IPv4-mapped IPv6 is normalised to IPv4. Falls back to the raw socket address if nothing valid resolves.
 */
export function clientIp(
  handshake: { address: string; headers: Record<string, string | string[] | undefined> },
  trust: { trustProxy: TrustProxyFn; behindCloudflare?: boolean },
): string {
  const peer = resolveForwardedIp(
    handshake.address,
    handshake.headers['x-forwarded-for'],
    trust.trustProxy,
  );
  const ip = resolveClientIp(peer, handshake.headers['cf-connecting-ip'], {
    behindCloudflare: trust.behindCloudflare === true,
  });
  return ip ?? handshake.address;
}

/** Socket.IO message size cap (bytes); realtime only carries small control messages. */
export const MAX_HTTP_BUFFER_SIZE = 16_384;
/** Window for the per-socket meeting:join limit. */
const JOIN_WINDOW_MS = 60_000;

/** Extension bearer sockets need this scope (ADR-011 section 1.3). */
export const EXTENSION_REQUIRED_SCOPE = 'recordings:write';
/** setTimeout's ceiling; longer expiries re-arm. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Rejects everything. Not used by main(); kept for tests and for wiring a server with auth deliberately off. */
export const denyAllVerifier: SessionVerifier = () => null;

/** The verified identity must match the client class the handshake came from (ADR-011 sections 1.1 and 1.3). */
function acceptable(ctx: AuthContext | null, kind: ClientKind, now: number): ctx is AuthContext {
  if (!ctx?.userId || !ctx.organizationId || !ctx.sessionId) return false;
  if (!(ctx.expiresAt instanceof Date) || !(ctx.expiresAt.getTime() > now)) return false;
  if (kind === 'web') return ctx.credential === 'session';
  return ctx.credential === 'extension' && (ctx.scopes ?? []).includes(EXTENSION_REQUIRED_SCOPE);
}

/** Realtime logger with contracts REDACT_KEYS redacted at any depth (ADR-005 A1.5). */
export function createRealtimeLogger(destination?: Parameters<typeof createLogger>[1]): Logger {
  return createLogger({ name: 'realtime', redactKeys: REDACT_KEYS }, destination);
}

export async function createRealtimeServer(
  opts: RealtimeServerOptions,
): Promise<{ app: FastifyInstance; io: RealtimeIo }> {
  const log: FastifyBaseLogger = createRealtimeLogger();
  // Fastify request logs go through the same redacting logger, never pino's unredacted default.
  const app = opts.logger ? Fastify({ loggerInstance: log }) : Fastify({ logger: false });
  const now = opts.now ?? Date.now;
  let redisReady = false;

  app.get('/health', async () => ({
    status: 'ok',
    adapter: opts.config.redisUrl ? 'redis' : 'memory',
    ...(opts.config.redisUrl ? { redis: redisReady ? 'up' : 'down' } : {}),
  }));

  const policy: HandshakePolicy = {
    webOrigins: new Set(opts.config.corsOrigins),
    extensionOrigins: new Set(opts.config.extensionOrigins),
    sessionCookieName: opts.config.sessionCookieName,
  };
  const io: RealtimeIo = new Server(app.server, {
    path: opts.config.path,
    maxHttpBufferSize: MAX_HTTP_BUFFER_SIZE,
    cors: {
      origin: [...opts.config.corsOrigins, ...opts.config.extensionOrigins],
      credentials: true,
    },
    // Enforce Origin at the HTTP handshake (CORS alone does not stop non-browser or websocket-only clients).
    allowRequest: (req, cb) => cb(null, classifyOrigin(req.headers.origin, policy) !== null),
  });

  // R19: after Engine.IO wraps the request listeners, so this runs first for Fastify and Socket.IO alike.
  installSecurityHeaders(app.server, { hsts: opts.config.hsts === true });

  const redisClients: Array<ReturnType<typeof createClient>> = [];
  if (opts.config.redisUrl) {
    const pub = createRealtimeRedis(opts.config.redisUrl);
    const sub = pub.duplicate();
    for (const c of [pub, sub]) c.on('error', (err: unknown) => log.error({ err }, 'redis error'));
    await Promise.all([pub.connect(), sub.connect()]);
    redisReady = true;
    redisClients.push(pub, sub);
    io.adapter(createAdapter(pub, sub));
  }

  const limiter = new ConnectionRateLimiter(opts.config.connLimitWindowMs, now);
  const joinLimiter = new ConnectionRateLimiter(JOIN_WINDOW_MS, now);
  const concurrency: ConcurrencyTracker =
    opts.concurrency ??
    (redisClients[0]
      ? createRedisConcurrencyTracker(redisClients[0])
      : createMemoryConcurrencyTracker());
  /** The handshake credential, kept server-side only (never in socket.data, never logged) for re-verification. */
  const credentials = new WeakMap<
    RealtimeSocket,
    { credential: RealtimeCredential; kind: ClientKind }
  >();

  // ADR-011 section 1.5: every rejection is the same generic error; the handshake (cookie, token, query) is never logged.
  io.use((socket, next) => {
    const unauthorized = () => next(new Error(REALTIME_CONNECT_ERROR));
    /**
     * Concurrency slots held by this handshake. They are released exactly once on every exit: rejection, verifier
     * error, the transport closing mid-handshake (where 'disconnect' never fires), or a normal disconnect.
     */
    const held: string[] = [];
    let closed = false;
    const releaseAll = () => {
      for (const key of held.splice(0)) void concurrency.release(key).catch(() => undefined);
    };
    const onClose = () => {
      closed = true;
      releaseAll();
    };
    socket.conn.once('close', onClose);
    const fail = () => {
      releaseAll();
      socket.conn.off('close', onClose);
      unauthorized();
    };
    const read = readHandshakeCredential(
      {
        headers: socket.handshake.headers,
        query: socket.handshake.query,
        auth: socket.handshake.auth,
      },
      policy,
    );
    const ip = clientIp(socket.handshake, opts.config);
    // Per-IP limit before any verifier work, so a flood cannot turn into database load.
    if (!limiter.take(`ip:${ip}`, opts.config.connLimitPerIp)) {
      log.warn('realtime connection rate limited (ip)');
      return fail();
    }
    if (!read.ok) return fail();
    const acquire = async (key: string, limit: number): Promise<boolean> => {
      if (closed) return false;
      if (!(await concurrency.acquire(key, limit))) return false;
      held.push(key);
      // The transport dropped while we were waiting: give the slot straight back.
      if (closed) {
        releaseAll();
        return false;
      }
      return true;
    };
    Promise.resolve()
      .then(() => opts.verifySession(read.credential))
      .then(async (ctx) => {
        if (closed) return fail();
        if (!acceptable(ctx, read.kind, now())) return fail();
        if (!limiter.take(`user:${ctx.userId}`, opts.config.connLimitPerUser)) {
          log.warn('realtime connection rate limited (user)');
          return fail();
        }
        if (!(await acquire(`ip:${ip}`, opts.config.maxSocketsPerIp))) {
          if (!closed) log.warn('realtime concurrent socket cap reached (ip)');
          return fail();
        }
        if (!(await acquire(`user:${ctx.userId}`, opts.config.maxSocketsPerUser))) {
          if (!closed) log.warn('realtime concurrent socket cap reached (user)');
          return fail();
        }
        socket.once('disconnect', releaseAll);
        credentials.set(socket, { credential: read.credential, kind: read.kind });
        socket.data.userId = ctx.userId;
        socket.data.organizationId = ctx.organizationId;
        socket.data.sessionId = ctx.sessionId;
        socket.data.credential = ctx.credential;
        socket.data.expiresAt = ctx.expiresAt.getTime();
        next();
      })
      .catch((err: unknown) => {
        log.warn(
          { errName: err instanceof Error ? err.name : typeof err },
          'session verification failed',
        );
        fail();
      });
  });

  io.on('connection', (socket: RealtimeSocket) => {
    /** Meeting ids this socket has joined (dedupes joins and enforces the per-socket room cap). */
    const joined = new Set<string>();
    // Only cookie (web) sockets get the org fan-out room; bearer sockets only receive meetings they join (1.3).
    // ADR-013: cookie sockets also get the user's notification room, derived only from the verified identity (never
    // from client input; there is no client join event for it). Bearer sockets keep joining no fan-out room.
    if (socket.data.credential === 'session') {
      void socket.join(organizationRoom(socket.data.organizationId));
      void socket.join(userRoom(socket.data.organizationId, socket.data.userId));
    }
    armExpiry(socket, now);
    const timer = setInterval(() => void revalidate(socket), opts.config.revalidateIntervalMs);
    timer.unref?.();
    socket.on('disconnect', () => clearInterval(timer));

    socket.on('meeting:join', (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => undefined;
      const meetingId = payload?.meetingId;
      if (typeof meetingId !== 'string' || !MEETING_ID_PATTERN.test(meetingId))
        return reply({ ok: false, error: 'invalid' });
      if (joined.has(meetingId)) return reply({ ok: true });
      if (!joinLimiter.take(`join:${socket.id}`, opts.config.joinLimitPerSocket))
        return reply({ ok: false, error: 'limit' });
      if (joined.size >= opts.config.maxRoomsPerSocket) return reply({ ok: false, error: 'limit' });
      Promise.resolve()
        .then(() =>
          opts.canAccessMeeting({
            organizationId: socket.data.organizationId,
            userId: socket.data.userId,
            meetingId,
          }),
        )
        .then(async (allowed) => {
          if (allowed !== true) return reply({ ok: false, error: 'forbidden' });
          if (!socket.connected) return reply({ ok: false, error: 'forbidden' });
          if (!joined.has(meetingId) && joined.size >= opts.config.maxRoomsPerSocket)
            return reply({ ok: false, error: 'limit' });
          joined.add(meetingId);
          await socket.join(meetingRoom(socket.data.organizationId, meetingId));
          reply({ ok: true });
        })
        .catch((err: unknown) => {
          log.error(
            { errName: err instanceof Error ? err.name : typeof err, meetingId },
            'meeting access check failed',
          );
          reply({ ok: false, error: 'error' });
        });
    });

    socket.on('meeting:leave', (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => undefined;
      const meetingId = payload?.meetingId;
      if (typeof meetingId !== 'string' || !MEETING_ID_PATTERN.test(meetingId))
        return reply({ ok: false, error: 'invalid' });
      joined.delete(meetingId);
      void Promise.resolve(socket.leave(meetingRoom(socket.data.organizationId, meetingId))).then(
        () => reply({ ok: true }),
      );
    });
  });

  const inFlight = new WeakSet<RealtimeSocket>();
  const reject = (socket: RealtimeSocket, reason: ReauthReason) => {
    if (!socket.connected) return;
    socket.emit(REALTIME_CONTROL_EVENTS.authReauthRequired, {
      reason,
      at: new Date(now()).toISOString(),
    });
    socket.disconnect(true);
  };
  /**
   * Re-verify a live socket's credential (ADR-011 section 3). It stays connected only if the verifier still returns
   * the same user, org and session/family for the same client class; otherwise, or on any error, it is told to
   * re-authenticate and disconnected (fail closed). A still-valid answer refreshes the expiry timer's deadline.
   */
  async function revalidate(socket: RealtimeSocket, reason: ReauthReason = 'revalidation_failed') {
    const c = credentials.get(socket);
    if (!c || !socket.connected || inFlight.has(socket)) return;
    inFlight.add(socket);
    try {
      const ctx = await opts.verifySession(c.credential);
      const same =
        acceptable(ctx, c.kind, now()) &&
        ctx.userId === socket.data.userId &&
        ctx.organizationId === socket.data.organizationId &&
        ctx.sessionId === socket.data.sessionId;
      if (!same) return reject(socket, reason);
      socket.data.expiresAt = Math.min(socket.data.expiresAt, ctx.expiresAt.getTime());
    } catch (err: unknown) {
      log.warn(
        { errName: err instanceof Error ? err.name : typeof err },
        'session re-verification failed',
      );
      reject(socket, reason);
    } finally {
      inFlight.delete(socket);
    }
  }

  /** ADR-011 section 3: re-verify the local sockets a revocation message names. Malformed messages are dropped. */
  const subscribeWanted = Boolean(opts.subscribeRevocations ?? opts.config.redisUrl);
  // Loaded lazily (like main()'s verifier) so a server without a revocation feed never imports it.
  const rev = subscribeWanted ? await import('@meetops/session-verifier') : undefined;
  const onRevocation = (raw: string) => {
    const m = rev?.parseRevocationMessage(raw);
    if (!m) return log.warn('dropped malformed revocation message');
    for (const socket of io.of('/').sockets.values()) {
      if (socket.data.userId !== m.userId) continue;
      if (m.kind === 'session' && socket.data.sessionId !== m.sessionId) continue;
      if (m.kind === 'membership' && socket.data.organizationId !== m.organizationId) continue;
      void revalidate(socket, m.reason === 'org_switch' ? 'org_switch' : 'revalidation_failed');
    }
  };
  const unsubscribers: Array<() => Promise<void> | void> = [];
  if (opts.subscribeRevocations) {
    unsubscribers.push(await opts.subscribeRevocations(onRevocation));
  } else if (rev && redisClients[0]) {
    const revSub = redisClients[0].duplicate();
    revSub.on('error', (err: unknown) => log.error({ err }, 'redis revocation subscriber error'));
    await revSub.connect();
    await revSub.subscribe(rev.AUTH_REVOCATIONS_CHANNEL, onRevocation);
    unsubscribers.push(() =>
      revSub
        .quit()
        .then(() => undefined)
        .catch(() => undefined),
    );
  }

  app.addHook('onClose', async () => {
    for (const u of unsubscribers) await u();
    await io.close();
    await Promise.all(redisClients.map((c) => c.quit().catch(() => undefined)));
  });

  return { app, io };
}

/**
 * At the credential's expiry, send `auth:reauth-required { reason: 'session_expired' }` and disconnect (the ARC-2
 * control event, via the local shim). Periodic and revocation-driven re-verification run in createRealtimeServer.
 */
function armExpiry(socket: RealtimeSocket, now: () => number): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    const left = socket.data.expiresAt - now();
    if (left > 0) {
      timer = setTimeout(check, Math.min(left, MAX_TIMER_MS));
      timer.unref?.();
      return;
    }
    socket.emit(REALTIME_CONTROL_EVENTS.authReauthRequired, {
      reason: 'session_expired',
      at: new Date(now()).toISOString(),
    });
    socket.disconnect(true);
  };
  socket.on('disconnect', () => clearTimeout(timer));
  check();
}

/** Emit helpers for producers in this process (other processes use the Redis adapter / emitter). */
export function emitToMeeting<E extends keyof ServerToClientEvents>(
  io: RealtimeIo,
  organizationId: string,
  meetingId: string,
  event: E,
  ...args: Parameters<ServerToClientEvents[E]>
): void {
  io.to(meetingRoom(organizationId, meetingId)).emit(event, ...args);
}

export function emitToOrg<E extends keyof ServerToClientEvents>(
  io: RealtimeIo,
  organizationId: string,
  event: E,
  ...args: Parameters<ServerToClientEvents[E]>
): void {
  io.to(organizationRoom(organizationId)).emit(event, ...args);
}

/**
 * Publish a media upload status to its organization (organizations:{id}) and meeting room. Each socket receives it
 * once (room union). Invalid or over-broad payloads are rejected rather than broadcast.
 */
export function emitUploadStatus(io: RealtimeIo, e: UploadStatusEvent): void {
  if (!isUploadStatusEvent(e)) throw new TypeError('invalid upload:status event');
  io.to([organizationRoom(e.organizationId), meetingRoom(e.organizationId, e.meetingId)]).emit(
    MEDIA_EVENTS.uploadStatus,
    e,
  );
}

export function emitProcessingStatus(io: RealtimeIo, e: ProcessingStatusEvent): void {
  if (!isProcessingStatusEvent(e)) throw new TypeError('invalid processing:status event');
  io.to([organizationRoom(e.organizationId), meetingRoom(e.organizationId, e.meetingId)]).emit(
    MEDIA_EVENTS.processingStatus,
    e,
  );
}
