import { createHash } from 'node:crypto';
import { DomainError } from '../../../shared/domain-error.js';

export type MeetingSource = 'upload' | 'extension' | 'desktop' | 'bot' | 'mobile';
export type MeetingStatus = 'scheduled' | 'recording' | 'processing' | 'completed' | 'failed';

export interface MeetingRecord {
  id: string;
  organizationId: string;
  projectId: string | null;
  createdById: string | null;
  title: string;
  source: MeetingSource;
  externalMeetingId: string | null;
  status: MeetingStatus;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MeetingCreate {
  title: string;
  source: MeetingSource;
  externalMeetingId: string;
  startedAt: Date | null;
  createdById: string;
}

export interface MeetingPage {
  items: MeetingRecord[];
  nextCursor: string | null;
}

/**
 * Meeting persistence port. Tenancy contract (same as the directory ports):
 * - the organization id always comes from the TenantContext / verified session, never from input;
 * - a missing, soft-deleted or other-organization meeting is `null` (identical 404 upstream);
 * - Prisma runs every call inside withOrganizationContext, so forced RLS applies too.
 */
export type AnalyticsBucket = 'day' | 'week' | 'month';

export interface MeetingAnalyticsQuery {
  /** Inclusive. */
  from: Date;
  /** Exclusive. */
  to: Date;
  bucket: AnalyticsBucket;
}

/** Aggregates over live (not soft-deleted) meetings with createdAt in [from, to). No ids or titles. */
export interface MeetingAnalyticsResult {
  total: number;
  bySource: { source: MeetingSource; count: number }[];
  byStatus: { status: MeetingStatus; count: number }[];
  duration: { measured: number; totalSec: number; averageSec: number | null };
  /** Non-empty UTC buckets, ascending. */
  periods: { start: Date; count: number }[];
}

/** Start of the UTC bucket containing `d` (weeks start on Monday, like Postgres date_trunc). */
export function bucketStart(d: Date, bucket: AnalyticsBucket): Date {
  const day = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  if (bucket === 'day') return new Date(day);
  if (bucket === 'month') return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  const dow = (new Date(day).getUTCDay() + 6) % 7; // Monday = 0
  return new Date(day - dow * 86_400_000);
}

export class InvalidAnalyticsRangeError extends DomainError {
  constructor(message: string) {
    super('VALIDATION_FAILED', message, 400);
  }
}

export interface MeetingRepository {
  /** Newest first, keyset on (createdAt, id) descending. Throws InvalidMeetingCursorError. */
  list(
    organizationId: string,
    q: { cursor?: string | undefined; limit: number; source?: MeetingSource | undefined },
  ): Promise<MeetingPage>;
  findById(organizationId: string, id: string): Promise<MeetingRecord | null>;
  /** Read-only aggregates for one organization (never another org's rows). */
  analytics(organizationId: string, q: MeetingAnalyticsQuery): Promise<MeetingAnalyticsResult>;
  /**
   * Find-or-create on (organizationId, source, externalMeetingId). Concurrent calls converge on one row;
   * `created` is true only for the call that inserted it.
   */
  resolve(
    organizationId: string,
    input: MeetingCreate,
  ): Promise<{ meeting: MeetingRecord; created: boolean }>;
}

/** Missing, soft-deleted and other-org ids all produce exactly this body. */
export class MeetingNotFoundError extends DomainError {
  constructor() {
    super('NOT_FOUND', 'Meeting not found', 404);
  }
}

export class InvalidMeetingCursorError extends DomainError {
  constructor() {
    super('BAD_REQUEST', 'Invalid cursor', 400);
  }
}

/** The external id could not be derived from `externalMeetingUrl` (or is not in the allowed charset). */
export class InvalidExternalMeetingError extends DomainError {
  constructor() {
    super('VALIDATION_FAILED', 'Cannot derive externalMeetingId from externalMeetingUrl', 400);
  }
}

/** The meeting URL is not on a supported meeting host (Meet, Zoom, Teams). */
export class UnsupportedMeetingHostError extends DomainError {
  constructor() {
    super('VALIDATION_FAILED', 'externalMeetingUrl is not a supported meeting host', 400);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);

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
export function deriveExternalMeetingId(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new InvalidExternalMeetingError();
  }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !isAllowedMeetingHost(host))
    throw new UnsupportedMeetingHostError();
  // Same as the extension (meetingUrlFromTab): a Teams `#/l/...` fragment path is folded in, then re-parsed as a URL
  // path exactly as the API sees the extension's `origin + path`, so raw and extension-normalized links agree.
  const folded = isTeamsHost(host) ? teamsFragmentPath(u.pathname, u.hash) : null;
  const rawPath = folded ? new URL(folded, `https://${host}`).pathname : u.pathname;
  // Decode %-escapes, then NFC so composed and decomposed Unicode (raw or %-encoded) give one id and one hash.
  const path = decodeSegments(rawPath).normalize('NFC').replace(/\/+$/, '');
  const id = `${host}${path}`;
  if (EXTERNAL_ID_RE.test(id)) return id;
  const hashed = `${host}/_h/${sha256Hex(id)}`;
  return hashed.length <= MAX_EXTERNAL_ID ? hashed : `_h/${sha256Hex(id)}`;
}
