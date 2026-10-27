import { Prisma, type Meeting } from '@prisma/client';
import type { DatabaseTransaction } from './index.js';

/** Default and maximum page size for listMeetingsPage(). */
export const MEETINGS_PAGE_DEFAULT_LIMIT = 20;
export const MEETINGS_PAGE_MAX_LIMIT = 100;

/** Position after the last item of a page: (createdAt, id) of that item. */
export interface MeetingsCursor {
  createdAt: Date;
  id: string;
}

export interface ListMeetingsPageOptions {
  /** Integer; clamped to 1..100. Default 20. Non-integers throw RangeError('invalid_limit'). */
  limit?: number;
  /** Decoded cursor (see decodeMeetingsCursor), or omitted for the first page. */
  cursor?: MeetingsCursor | null;
}

export interface MeetingsPage {
  items: Meeting[];
  /** Pass to the next call (or encodeMeetingsCursor it for the client); null when there are no more rows. */
  nextCursor: MeetingsCursor | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Opaque, URL-safe cursor string for API responses. */
export function encodeMeetingsCursor(cursor: MeetingsCursor): string {
  return Buffer.from(
    JSON.stringify({ c: cursor.createdAt.toISOString(), i: cursor.id }),
    'utf8',
  ).toString('base64url');
}

/** Parse a cursor from encodeMeetingsCursor. Throws RangeError('invalid_cursor') on anything else. */
export function decodeMeetingsCursor(value: string): MeetingsCursor {
  try {
    const raw: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (raw && typeof raw === 'object') {
      const { c, i } = raw as { c?: unknown; i?: unknown };
      if (typeof c === 'string' && typeof i === 'string' && UUID_RE.test(i)) {
        const createdAt = new Date(c);
        if (!Number.isNaN(createdAt.getTime()) && createdAt.toISOString() === c) {
          return { createdAt, id: i.toLowerCase() };
        }
      }
    }
  } catch {
    // fall through
  }
  throw new RangeError('invalid_cursor');
}

/** Clamp a page size to 1..MEETINGS_PAGE_MAX_LIMIT; RangeError('invalid_limit') if not an integer. */
export function clampMeetingsLimit(limit: number | undefined): number {
  if (limit === undefined) return MEETINGS_PAGE_DEFAULT_LIMIT;
  if (!Number.isInteger(limit)) throw new RangeError('invalid_limit');
  return Math.min(Math.max(limit, 1), MEETINGS_PAGE_MAX_LIMIT);
}

/**
 * listMeetingsPage(tx, { limit?, cursor? }): one page of live meetings of the CURRENT org, newest first,
 * ordered by (created_at DESC, id DESC) with keyset `(created_at, id) < cursor`. Call it inside
 * withOrgContext(orgId, (tx) => listMeetingsPage(tx, ...)); without an org context it returns no rows.
 * Uses index meetings_org_id_created_at_id_idx.
 */
export async function listMeetingsPage(
  tx: DatabaseTransaction,
  options: ListMeetingsPageOptions = {},
): Promise<MeetingsPage> {
  const limit = clampMeetingsLimit(options.limit);
  const cursor = options.cursor ?? null;
  const keyset = cursor
    ? Prisma.sql`AND (created_at, id) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`
    : Prisma.empty;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM meetings
    WHERE org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid
      AND deleted_at IS NULL
      ${keyset}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit + 1}`;
  const pageIds = rows.slice(0, limit).map((r) => r.id);
  const found = pageIds.length
    ? await tx.meeting.findMany({ where: { id: { in: pageIds }, deletedAt: null } })
    : [];
  const byId = new Map(found.map((m) => [m.id, m]));
  const items = pageIds.map((id) => byId.get(id)).filter((m): m is Meeting => m !== undefined);
  const last = items.at(-1);
  const nextCursor =
    rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null;
  return { items, nextCursor };
}
