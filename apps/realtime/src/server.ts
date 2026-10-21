import Fastify, { type FastifyInstance } from 'fastify';
import { Server, type Socket } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';
import { createLogger } from '@meetops/logger';
import type { RealtimeConfig } from './config.js';
import {
  meetingRoom,
  orgRoom,
  type ClientToServerEvents,
  type InterServerEvents,
  type ServerToClientEvents,
  type SocketData
} from './events.js';

export type AuthContext = { userId: string; orgId: string };

/**
 * Session verifier placeholder. Receives the handshake auth payload and headers;
 * return the identity or null/throw to reject the connection.
 */
export type SessionVerifier = (input: {
  token: string | undefined;
  headers: Record<string, string | string[] | undefined>;
}) => Promise<AuthContext | null> | AuthContext | null;

/** Decide whether an org may access a meeting. */
export type MeetingAccessHook = (input: { orgId: string; userId: string; meetingId: string }) => Promise<boolean> | boolean;

export type RealtimeIo = Server<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

export type RealtimeServerOptions = {
  config: RealtimeConfig;
  verifySession: SessionVerifier;
  canAccessMeeting: MeetingAccessHook;
  logger?: boolean;
};

const MEETING_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Default verifier: rejects everything until real auth is wired in. */
export const denyAllVerifier: SessionVerifier = () => null;

export async function createRealtimeServer(opts: RealtimeServerOptions): Promise<{ app: FastifyInstance; io: RealtimeIo }> {
  const log = createLogger({ name: 'realtime' });
  const app = Fastify({ logger: opts.logger ?? false });
  let redisReady = false;

  app.get('/health', async () => ({
    status: 'ok',
    adapter: opts.config.redisUrl ? 'redis' : 'memory',
    ...(opts.config.redisUrl ? { redis: redisReady ? 'up' : 'down' } : {})
  }));

  const io: RealtimeIo = new Server(app.server, {
    path: opts.config.path,
    cors: { origin: opts.config.corsOrigins, credentials: opts.config.corsOrigins !== '*' }
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

  io.use((socket, next) => {
    const auth = socket.handshake.auth as { token?: unknown } | undefined;
    const token = typeof auth?.token === 'string' ? auth.token : undefined;
    Promise.resolve()
      .then(() => opts.verifySession({ token, headers: socket.handshake.headers }))
      .then((ctx) => {
        if (!ctx?.userId || !ctx.orgId) return next(new Error('unauthorized'));
        socket.data.userId = ctx.userId;
        socket.data.orgId = ctx.orgId;
        next();
      })
      .catch(() => next(new Error('unauthorized')));
  });

  io.on('connection', (socket: Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>) => {
    void socket.join(orgRoom(socket.data.orgId));

    socket.on('meeting:join', (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => undefined;
      const meetingId = payload?.meetingId;
      if (typeof meetingId !== 'string' || !MEETING_ID.test(meetingId)) return reply({ ok: false, error: 'invalid' });
      Promise.resolve()
        .then(() => opts.canAccessMeeting({ orgId: socket.data.orgId, userId: socket.data.userId, meetingId }))
        .then(async (allowed) => {
          if (!allowed) return reply({ ok: false, error: 'forbidden' });
          await socket.join(meetingRoom(meetingId));
          reply({ ok: true });
        })
        .catch((err: unknown) => {
          log.error({ err, meetingId }, 'meeting access check failed');
          reply({ ok: false, error: 'error' });
        });
    });

    socket.on('meeting:leave', (payload, ack) => {
      const reply = typeof ack === 'function' ? ack : () => undefined;
      if (typeof payload?.meetingId !== 'string') return reply({ ok: false, error: 'invalid' });
      void Promise.resolve(socket.leave(meetingRoom(payload.meetingId))).then(() => reply({ ok: true }));
    });
  });

  app.addHook('onClose', async () => {
    await io.close();
    await Promise.all(redisClients.map((c) => c.quit().catch(() => undefined)));
  });

  return { app, io };
}

/** Emit helpers for producers in this process (other processes use the Redis adapter / emitter). */
export function emitToMeeting<E extends keyof ServerToClientEvents>(
  io: RealtimeIo,
  meetingId: string,
  event: E,
  ...args: Parameters<ServerToClientEvents[E]>
): void {
  io.to(meetingRoom(meetingId)).emit(event, ...args);
}

export function emitToOrg<E extends keyof ServerToClientEvents>(
  io: RealtimeIo,
  orgId: string,
  event: E,
  ...args: Parameters<ServerToClientEvents[E]>
): void {
  io.to(orgRoom(orgId)).emit(event, ...args);
}
