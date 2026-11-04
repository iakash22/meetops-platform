import type { AddressInfo } from 'node:net';
import { io as ioc, type Socket as ClientSocket } from 'socket.io-client';
import {
  createRealtimeServer,
  loadRealtimeConfig,
  type AuthContext,
  type ClientToServerEvents,
  type RealtimeCredential,
  type RealtimeServerOptions,
  type RealtimeServerToClientEvents,
} from '../src/index.js';

export type C = ClientSocket<RealtimeServerToClientEvents, ClientToServerEvents>;

export const ORIGIN = 'https://app.example.com';
export const EXT_ID = 'abcdefghijklmnopabcdefghijklmnop';
export const EXT_ORIGIN = `chrome-extension://${EXT_ID}`;
/** vitest runs with NODE_ENV=test, so the strict cookie name applies. */
export const COOKIE = '__Host-meetops_sid';

export const ORG_A = '11111111-1111-4111-8111-111111111111';
export const ORG_B = '22222222-2222-4222-8222-222222222222';
export const MEETING_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const MEETING_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const MEETING_MISSING = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const MEETINGS: Record<string, string> = { [MEETING_A]: ORG_A, [MEETING_B]: ORG_B };

const FAR = new Date(Date.now() + 3_600_000);
const session = (userId: string, organizationId: string, sessionId: string): AuthContext => ({
  userId,
  organizationId,
  sessionId,
  credential: 'session',
  expiresAt: FAR,
});
const extension = (
  userId: string,
  organizationId: string,
  sessionId: string,
  scopes: string[],
): AuthContext => ({
  userId,
  organizationId,
  sessionId,
  credential: 'extension',
  scopes,
  expiresAt: FAR,
});

/** Fake BE-6 verifier: cookie values and bearer tokens -> identities. Unknown -> null. */
export const COOKIES: Record<string, AuthContext> = {
  a1: session('u1', ORG_A, 's1'),
  a2: session('u2', ORG_A, 's2'),
  b1: session('u3', ORG_B, 's3'),
};
export const BEARERS: Record<string, AuthContext> = {
  xa1: extension('u1', ORG_A, 'x1', ['recordings:write']),
  xnoscope: extension('u1', ORG_A, 'x2', ['meetings:read']),
  /** A verifier answer that does not match the handshake class (cookie session via bearer). */
  xsession: session('u1', ORG_A, 'x3'),
};

export const fakeVerifier = (c: RealtimeCredential): AuthContext | null =>
  'cookie' in c ? (COOKIES[c.cookie] ?? null) : (BEARERS[c.bearer] ?? null);

export const fakeAccess: RealtimeServerOptions['canAccessMeeting'] = ({
  organizationId,
  meetingId,
}) => MEETINGS[meetingId] === organizationId;

const cleanups: Array<() => Promise<void> | void> = [];
export async function runCleanups(): Promise<void> {
  while (cleanups.length) await cleanups.pop()!();
}

export async function start(
  over: Partial<RealtimeServerOptions> = {},
  env: Record<string, string> = {},
) {
  const { app, io } = await createRealtimeServer({
    config: loadRealtimeConfig({
      REALTIME_PORT: '0',
      REALTIME_CORS_ORIGINS: ORIGIN,
      REALTIME_EXTENSION_IDS: EXT_ID,
      // Force the in-memory adapter: never inherit REDIS_URL from the shell/.env
      // (a live Redis connect hangs createRealtimeServer when Redis is down).
      REDIS_URL: '',
      ...env,
    }),
    verifySession: fakeVerifier,
    canAccessMeeting: fakeAccess,
    ...over,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  cleanups.push(() => app.close());
  return { app, io, url: `http://127.0.0.1:${(app.server.address() as AddressInfo).port}` };
}

export type ConnectOpts = {
  cookie?: string;
  /** Raw Cookie header (overrides cookie). */
  cookieHeader?: string;
  token?: unknown;
  origin?: string | null;
  query?: Record<string, string>;
  /** Extra request headers (for example X-Forwarded-For). */
  headers?: Record<string, string>;
};

/** Web client by default (Origin = ORIGIN). Pass origin: EXT_ORIGIN for an extension client. */
export function connect(url: string, o: ConnectOpts = {}): C {
  const headers: Record<string, string> = { ...o.headers };
  const origin = o.origin === undefined ? ORIGIN : o.origin;
  if (origin) headers.origin = origin;
  const cookie = o.cookieHeader ?? (o.cookie !== undefined ? `${COOKIE}=${o.cookie}` : undefined);
  if (cookie) headers.cookie = cookie;
  const s: C = ioc(url, {
    auth: o.token !== undefined ? { token: o.token } : {},
    transports: ['websocket'],
    reconnection: false,
    forceNew: true,
    extraHeaders: headers,
    ...(o.query ? { query: o.query } : {}),
  });
  cleanups.push(() => void s.disconnect());
  return s;
}

export const web = (url: string, cookie: string) => connect(url, { cookie });
export const ext = (url: string, token: string) => connect(url, { origin: EXT_ORIGIN, token });

export const connected = (s: C) =>
  new Promise<void>((res, rej) => {
    s.once('connect', () => res());
    s.once('connect_error', rej);
  });

export const nextEvent = <E extends keyof RealtimeServerToClientEvents>(s: C, e: E, ms = 300) =>
  new Promise<Parameters<RealtimeServerToClientEvents[E]>[0] | 'timeout'>((res) => {
    const t = setTimeout(() => res('timeout'), ms);
    s.once(e, ((p: Parameters<RealtimeServerToClientEvents[E]>[0]) => {
      clearTimeout(t);
      res(p);
    }) as never);
  });

export const roomsOf = (io: Awaited<ReturnType<typeof start>>['io'], userId: string) =>
  [...io.sockets.sockets.values()].filter((s) => s.data.userId === userId).map((s) => [...s.rooms]);
