import { normalizeExtensionOrigin, normalizeOrigin } from './config.js';

/**
 * ADR-011 section 1: the one credential a handshake may carry. Structurally the same as
 * @meetops/session-verifier's VerifyInput, so its verifySession can be passed in directly.
 */
export type RealtimeCredential = { cookie: string } | { bearer: string };

/** Which client class the handshake Origin belongs to. */
export type ClientKind = 'web' | 'extension';

export type HandshakeInput = {
  headers: Record<string, string | string[] | undefined>;
  query: Record<string, unknown>;
  auth: unknown;
};

export type HandshakePolicy = {
  webOrigins: ReadonlySet<string>;
  extensionOrigins: ReadonlySet<string>;
  sessionCookieName: string;
};

export type HandshakeResult =
  { ok: true; kind: ClientKind; credential: RealtimeCredential } | { ok: false };

/**
 * Query keys Socket.IO / Engine.IO set themselves. Anything else in the handshake query is rejected, so a token
 * can never ride in the URL (ADR-011 section 1.2). Query values are never logged.
 */
const ENGINE_QUERY_KEYS = new Set(['EIO', 'transport', 't', 'j', 'b64']);
/** Both session cookie names; an extension handshake carrying either is rejected (ADR-011 section 1.2). */
const SESSION_COOKIE_NAMES = ['__Host-meetops_sid', 'meetops_sid'];

/** Classify an Origin header value against the web and extension allowlists. */
export function classifyOrigin(
  raw: unknown,
  policy: Pick<HandshakePolicy, 'webOrigins' | 'extensionOrigins'>,
): ClientKind | null {
  if (typeof raw !== 'string') return null;
  const web = normalizeOrigin(raw);
  if (web !== null && policy.webOrigins.has(web)) return 'web';
  const ext = normalizeExtensionOrigin(raw);
  if (ext !== null && policy.extensionOrigins.has(ext)) return 'extension';
  return null;
}

/** All values of cookie `name` in a Cookie header (more than one is treated as ambiguous by the caller). */
export function readCookies(header: string | string[] | undefined, name: string): string[] {
  const raw = Array.isArray(header) ? header.join('; ') : (header ?? '');
  const out: string[] = [];
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    let v = part.slice(i + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    try {
      out.push(decodeURIComponent(v));
    } catch {
      out.push(v);
    }
  }
  return out;
}

/**
 * ADR-011 section 1. Pick exactly one credential from the handshake, or reject:
 * - web Origin: the session cookie only; `auth.token` present -> reject (1.1)
 * - extension Origin: `auth.token` only; a session cookie present -> reject (1.2, 1.3)
 * - any non-Engine.IO query key -> reject (1.2); any other Origin -> reject
 * The caller turns every rejection into the same generic `unauthorized` error (1.5).
 */
export function readHandshakeCredential(
  h: HandshakeInput,
  policy: HandshakePolicy,
): HandshakeResult {
  const kind = classifyOrigin(h.headers.origin, policy);
  if (!kind) return { ok: false };
  if (Object.keys(h.query ?? {}).some((k) => !ENGINE_QUERY_KEYS.has(k))) return { ok: false };

  const auth = h.auth && typeof h.auth === 'object' ? (h.auth as Record<string, unknown>) : {};
  const hasToken = auth.token !== undefined;
  if (hasToken && typeof auth.token !== 'string') return { ok: false };
  const token = hasToken ? (auth.token as string) : undefined;

  if (kind === 'web') {
    if (hasToken) return { ok: false };
    const cookies = readCookies(h.headers.cookie, policy.sessionCookieName);
    if (cookies.length !== 1 || !cookies[0]) return { ok: false };
    return { ok: true, kind, credential: { cookie: cookies[0] } };
  }

  if (SESSION_COOKIE_NAMES.some((n) => readCookies(h.headers.cookie, n).length > 0))
    return { ok: false };
  if (!token) return { ok: false };
  return { ok: true, kind, credential: { bearer: token } };
}
