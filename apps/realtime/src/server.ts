import Fastify, { type FastifyInstance } from 'fastify';
import { Server, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { createLogger } from '@meetops/logger';
import type { RealtimeConfig } from './config.js';
import { REALTIME_CONTROL_EVENTS } from './control-events.js';
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
  type ClientToServerEvents,
  type InterServerEvents,
  type MeetingAccessInput,
  type ProcessingStatusEvent,
  type RealtimeServerToClientEvents as ServerToClientEvents,
  type SocketData,
  type UploadStatusEvent,
} from './events.js';

/** What the verifier returns (a structural subset of @meetops/session-verifier's VerifiedSession). */
export type AuthContext = {
  userId: string;
  organizationId: string;
  sessionId: string;
  credential: 'session' | 'extension';
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
};

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

export async function createRealtimeServer(
  opts: RealtimeServerOptions,
): Promise<{ app: FastifyInstance; io: RealtimeIo }> {
  const log = createLogger({ name: 'realtime' });
  const app = Fastify({ logger: opts.logger ?? false });
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
    cors: {
      origin: [...opts.config.corsOrigins, ...opts.config.extensionOrigins],
      credentials: true,
    },
    // Enforce Origin at the HTTP handshake (CORS alone does not stop non-browser or websocket-only clients).
    allowRequest: (req, cb) => cb(null, classifyOrigin(req.headers.origin, policy) !== null),
  });

  const redisClients: Array<ReturnType<typeof createClient>> = [];
  if (opts.config.redisUrl) {
    const pub = createClient({ url: opts.config.redisUrl });
    const sub = pub.duplicate();
    for (const c of [pub, sub]) c.on('error', (err: unknown) => log.error({ err }, 'redis error'));
    await Promise.all([pub.connect(), sub.connect()]);
    redisReady = true;
    redisClients.push(pub, sub);
    io.adapter(createAdapter(pub, sub));
  }

  // ADR-011 section 1.5: every rejection is the same generic error; the handshake (cookie, token, query) is never logged.
  io.use((socket, next) => {
    const unauthorized = () => next(new Error(REALTIME_CONNECT_ERROR));
    const read = readHandshakeCredential(
      {
        headers: socket.handshake.headers,
        query: socket.handshake.query,
        auth: socket.handshake.auth,
      },
      policy,
    );
    if (!read.ok) return unauthorized();
    Promise.resolve()
      .then(() => opts.verifySession(read.credential))
      .then((ctx) => {
        if (!acceptable(ctx, read.kind, now())) return unauthorized();
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
        unauthorized();
      });
  });

  io.on('connection', (socket: RealtimeSocket) => {
    // Only cookie (web) sockets get the org fan-out room; bearer sockets only receive meetings they join (1.3).
    if (socket.data.credential === 'session')
      void socket.join(organizationRoom(socket.data.organizationId));
    armExpiry(socket, now);

    socket.on('meeting:join', (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => undefined;
      const meetingId = payload?.meetingId;
      if (typeof meetingId !== 'string' || !MEETING_ID_PATTERN.test(meetingId))
        return reply({ ok: false, error: 'invalid' });
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
      if (typeof payload?.meetingId !== 'string') return reply({ ok: false, error: 'invalid' });
      void Promise.resolve(
        socket.leave(meetingRoom(socket.data.organizationId, payload.meetingId)),
      ).then(() => reply({ ok: true }));
    });
  });

  app.addHook('onClose', async () => {
    await io.close();
    await Promise.all(redisClients.map((c) => c.quit().catch(() => undefined)));
  });

  return { app, io };
}

/**
 * At the credential's expiry, send `auth:reauth-required { reason: 'session_expired' }` and disconnect (the ARC-2
 * control event, via the local shim). Periodic and revocation-driven re-verification is MR-2.
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
