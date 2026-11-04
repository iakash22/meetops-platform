import { createHash } from 'node:crypto';

/**
 * Meeting-URL -> externalMeetingId derivation, shared by the API (meetings/resolve, calendar suggestions) and the
 * worker (calendar auto-link) so both always derive the same id. Moved verbatim from apps/api meetings/domain.
 */

const EXTERNAL_ID_RE = /^[A-Za-z0-9_.:@/-]{1,255}$/;
const MAX_EXTERNAL_ID = 255;

/** Meeting hosts the resolve endpoint derives ids for (exact host, or any subdomain of a `*.` entry). */
export const MEETING_HOSTS = {
  exact: [
    'meet.google.com',
    'teams.microsoft.com',
    'teams.live.com',
    'teams.microsoft.us',
    'gov.teams.microsoft.us',
    'dod.teams.microsoft.us',
    'zoom.us',
    'zoomgov.com',
  ],
  suffix: ['.zoom.us', '.zoomgov.com', '.zoom.com'],
} as const;

export function isAllowedMeetingHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  // No trailing, leading or double dots: `meet.google.com.` and `a..zoom.us` are refused, not normalized.
  if (!h || h.startsWith('.') || h.endsWith('.') || h.includes('..')) return false;
  return (
    (MEETING_HOSTS.exact as readonly string[]).includes(h) ||
    MEETING_HOSTS.suffix.some((s) => h.endsWith(s) && h.length > s.length)
  );
}

const isTeamsHost = (h: string) => h.startsWith('teams.') || h.includes('.teams.');

/**
 * Teams web links carry the meeting in the fragment: `/_#/l/meetup-join/...` (classic) and
 * `/v2/?meetingjoin=true#/l/meetup-join/...` (new client). Fold that fragment path into the path so both forms map
 * to the same id as the direct `/l/meetup-join/...` link instead of colliding on `teams.microsoft.com/_` or `/v2`.
 */
export function teamsFragmentPath(pathname: string, hash: string): string | null {
  if (!/^\/(?:_|v2)?\/?$/.test(pathname) || !hash.startsWith('#/')) return null;
  const p = hash.slice(1).split('?')[0]!;
  return p.length > 1 ? p : null;
}

function decodeSegments(path: string): string {
  return path
    .split('/')
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join('/');
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

/**
 * Contracts: when only a URL is sent, the server derives `externalMeetingId` from it (normalized host and path).
 * Host is lower-cased (IDN hosts arrive as punycode via WHATWG URL), query dropped, trailing slashes trimmed,
 * %-escapes decoded (older Teams links use `19%3ameeting_...%40thread.v2`): `meet.google.com/abc-defg-hij`.
 * Teams fragment links are folded first (see teamsFragmentPath). An id outside the contract charset (e.g. an IDN
 * path) or over 255 chars is replaced by a stable `host/_h/<sha256>` (or `_h/<sha256>`) instead of a 400.
 * Only allow-listed meeting hosts are accepted.
 */
export function deriveExternalMeetingIdResult(
  url: string,
): { ok: true; id: string } | { ok: false; reason: 'invalid' | 'unsupported_host' } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !isAllowedMeetingHost(host))
    return { ok: false, reason: 'unsupported_host' };
  // Same as the extension (meetingUrlFromTab): a Teams `#/l/...` fragment path is folded in, then re-parsed as a URL
  // path exactly as the API sees the extension's `origin + path`, so raw and extension-normalized links agree.
  const folded = isTeamsHost(host) ? teamsFragmentPath(u.pathname, u.hash) : null;
  const rawPath = folded ? new URL(folded, `https://${host}`).pathname : u.pathname;
  // Decode %-escapes, then NFC so composed and decomposed Unicode (raw or %-encoded) give one id and one hash.
  const path = decodeSegments(rawPath).normalize('NFC').replace(/\/+$/, '');
  const id = `${host}${path}`;
  if (EXTERNAL_ID_RE.test(id)) return { ok: true, id };
  const hashed = `${host}/_h/${sha256Hex(id)}`;
  return { ok: true, id: hashed.length <= MAX_EXTERNAL_ID ? hashed : `_h/${sha256Hex(id)}` };
}
