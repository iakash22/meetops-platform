/**
 * The meeting a new recording belongs to (InitRecordingSessionRequest.meetingId). The only place the extension
 * decides a meetingId.
 *
 * With WXT_FEATURE_HTTP_UPLOAD on, the popup asks the background (RESOLVE_MEETING, popup-only) and the background
 * finds or creates the meeting with `POST /orgs/:organizationId/meetings/resolve` (contracts `ResolveMeetingRequest`,
 * idempotent per org + source + external meeting id) through the bearer `apiFetch`. The tab URL is reduced to
 * origin + path first, so query strings (e.g. Zoom `pwd=`) and fragments never leave the browser. With the flag off
 * (stub uploads), a fresh random UUID is used, as before.
 *
 * Never logs; errors carry only the HTTP status and API error code.
 */
import type {
  ApiErrorEnvelope,
  ResolveMeetingRequest,
  ResolveMeetingResponse,
} from '@meetops/contracts/types';
import { fillPath } from './api-paths.js';
import {
  isNetworkError,
  isRetryableStatus,
  retryPolicy,
  withRetry,
  type RetryPolicy,
} from './retry.js';
import { UUID_RE } from './upload.js';

/** API route (meetings module; not in contracts MEETING_PATHS yet). test/contract-paths pins it to the API. */
export const MEETINGS_RESOLVE_ROUTE = '/orgs/:organizationId/meetings/resolve';

/** popup -> background */
export interface ResolveMeetingMessage {
  target: 'background';
  type: 'RESOLVE_MEETING';
  tabId: number;
}
export type ResolveMeetingResult = { ok: true; meetingId: string } | { ok: false; error: string };

export function isResolveMeetingMessage(msg: unknown): msg is ResolveMeetingMessage {
  if (typeof msg !== 'object' || msg === null) return false;
  const m = msg as Record<string, unknown>;
  return (
    m.target === 'background' &&
    m.type === 'RESOLVE_MEETING' &&
    typeof m.tabId === 'number' &&
    Number.isInteger(m.tabId) &&
    m.tabId >= 0
  );
}

export class MeetingResolveError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`Meeting resolve failed: HTTP ${status} ${code}`);
    this.name = 'MeetingResolveError';
  }
}

/** L-1: meeting hosts the extension resolves (exact host, or a subdomain of a `.` suffix). Mirrors the API list. */
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
  const h = hostname.toLowerCase().replace(/\.$/, '');
  return (
    (MEETING_HOSTS.exact as readonly string[]).includes(h) ||
    MEETING_HOSTS.suffix.some((s) => h.endsWith(s) && h.length > s.length)
  );
}

const isTeamsHost = (h: string) => h.startsWith('teams.') || h.includes('.teams.');

/**
 * M-2: Teams web links put the meeting in the fragment (`/_#/l/meetup-join/...`, `/v2/?meetingjoin=true#/l/...`).
 * Only the fragment's path is kept (its query is dropped), so different meetings don't all collapse onto `/_` or `/v2`.
 */
function teamsFragmentPath(pathname: string, hash: string): string | null {
  if (!/^\/(?:_|v2)?\/?$/.test(pathname) || !hash.startsWith('#/')) return null;
  const p = hash.slice(1).split('?')[0]!;
  return p.length > 1 ? p : null;
}

/**
 * The tab must be an https page on a meeting host (L-1); only origin + path are sent (no query, no credentials).
 * The fragment is dropped too, except the path inside a Teams `#/l/...` fragment (see teamsFragmentPath).
 */
export function meetingUrlFromTab(url: string | undefined): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  if (!isAllowedMeetingHost(u.hostname)) return null;
  const path = (isTeamsHost(u.hostname) && teamsFragmentPath(u.pathname, u.hash)) || u.pathname;
  return `${u.origin}${path}`;
}

export interface MeetingResolverDeps {
  api: (path: string, init: RequestInit) => Promise<Response>;
  organizationId: () => Promise<string>;
  validators: {
    request: (v: unknown) => v is ResolveMeetingRequest;
    response: (v: unknown) => v is ResolveMeetingResponse;
    apiError: (v: unknown) => v is ApiErrorEnvelope;
  };
  retry?: Partial<RetryPolicy>;
}

/** Finds or creates the meeting for a tab URL. Safe to retry: the endpoint is idempotent. */
export function createMeetingResolver(d: MeetingResolverDeps) {
  const policy = retryPolicy(d.retry);
  return async (tabUrl: string | undefined): Promise<string> => {
    const externalMeetingUrl = meetingUrlFromTab(tabUrl);
    if (!externalMeetingUrl) throw new MeetingResolveError(0, 'UNSUPPORTED_PAGE');
    const body: ResolveMeetingRequest = { source: 'extension', externalMeetingUrl };
    if (!d.validators.request(body)) throw new MeetingResolveError(0, 'UNSUPPORTED_PAGE');
    const path = fillPath(MEETINGS_RESOLVE_ROUTE, { organizationId: await d.organizationId() });
    const res = await withRetry(
      async () => {
        const r = await d.api(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(body),
          cache: 'no-store',
        });
        if (!r.ok) {
          const json: unknown = await r.json().catch(() => undefined);
          throw new MeetingResolveError(
            r.status,
            d.validators.apiError(json) ? json.error.code : 'INVALID_RESPONSE',
          );
        }
        const json: unknown = await r.json().catch(() => undefined);
        if (!d.validators.response(json))
          throw new MeetingResolveError(r.status, 'INVALID_RESPONSE');
        return json;
      },
      (err) => ({
        retry:
          (err instanceof MeetingResolveError && isRetryableStatus(err.status)) ||
          isNetworkError(err),
      }),
      policy,
    );
    return res.meetingId;
  };
}

/** Popup side: ask the background for this tab's meetingId. */
export async function resolveMeetingId(
  tabId: number,
  send: (msg: ResolveMeetingMessage) => Promise<ResolveMeetingResult>,
): Promise<string> {
  const res = await send({ target: 'background', type: 'RESOLVE_MEETING', tabId });
  if (!res.ok) throw new Error(res.error);
  if (!UUID_RE.test(res.meetingId)) throw new Error('Meeting resolve returned an invalid id');
  return res.meetingId;
}
