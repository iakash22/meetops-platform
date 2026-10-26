/**
 * Deep-link guard for `?next=` on the sign-in route (e.g. `meetops://login?next=/tasks`). After sign-in the app only
 * follows it when it is one of the app's own screens. Anything else (external
 * URLs, protocol-relative `//host`, backslashes, encoded tricks, auth screens, unknown paths) falls back to home.
 */
export const RETURNABLE_ROUTES = ['/', '/tasks', '/record', '/account', '/organizations'] as const;
export type ReturnableRoute = (typeof RETURNABLE_ROUTES)[number];

const MAX_LENGTH = 64;

export function safeReturnPath(raw: unknown): ReturnableRoute | null {
  const value = Array.isArray(raw) ? (raw as unknown[])[0] : raw;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_LENGTH) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/') || decoded.startsWith('//') || decoded.includes('\\')) return null;
  const path = decoded.split(/[?#]/, 1)[0] ?? '';
  const normalized = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  return (RETURNABLE_ROUTES as readonly string[]).includes(normalized)
    ? (normalized as ReturnableRoute)
    : null;
}

let pending: ReturnableRoute | null = null;

/**
 * Remember a safe `next` across the hop from the sign-in group into the app group. Params do not survive a redirect
 * into a navigator that is not mounted yet, so the target is held here and taken once by the app group.
 */
export function rememberReturn(raw: unknown): void {
  const next = safeReturnPath(raw);
  pending = next && next !== '/' ? next : null;
}

/** The remembered target, cleared on read. */
export function takeReturn(): ReturnableRoute | null {
  const next = pending;
  pending = null;
  return next;
}
