import { DomainError } from '../../../shared/domain-error.js';

export type MeetingSource = 'upload' | 'extension' | 'desktop' | 'bot';
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
export interface MeetingRepository {
  /** Newest first, keyset on (createdAt, id) descending. Throws InvalidMeetingCursorError. */
  list(
    organizationId: string,
    q: { cursor?: string | undefined; limit: number },
  ): Promise<MeetingPage>;
  findById(organizationId: string, id: string): Promise<MeetingRecord | null>;
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

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (s: string) => UUID_RE.test(s);

const EXTERNAL_ID_RE = /^[A-Za-z0-9_.:@/-]{1,255}$/;

/**
 * Contracts: when only a URL is sent, the server derives `externalMeetingId` from it (normalized host and path).
 * Host is lower-cased, query/fragment dropped, trailing slashes trimmed: `meet.google.com/abc-defg-hij`.
 */
export function deriveExternalMeetingId(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new InvalidExternalMeetingError();
  }
  const path = u.pathname.replace(/\/+$/, '');
  const id = `${u.hostname.toLowerCase()}${path}`;
  if (!EXTERNAL_ID_RE.test(id)) throw new InvalidExternalMeetingError();
  return id;
}
