import type { MeetingRecord } from '../meetings/domain/meeting.js';
import { withOrganizationContext, type DatabaseClient } from '../../shared/prisma/context.js';
import type { CalendarEventLinkRow, CalendarEventLinksRepository } from './ports.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MATCH_IDS = 500;

function uniqueMatches(rows: { id: string; externalMeetingId: string | null }[]) {
  const seen = new Map<string, string | null>();
  for (const r of rows) {
    if (!r.externalMeetingId) continue;
    seen.set(r.externalMeetingId, seen.has(r.externalMeetingId) ? null : r.id);
  }
  const out = new Map<string, string>();
  for (const [k, v] of seen) if (v) out.set(k, v);
  return out;
}

/** Prisma links. Every query runs in withOrganizationContext (forced RLS) and also filters by org (and user). */
export class PrismaCalendarEventLinks implements CalendarEventLinksRepository {
  constructor(private readonly db: DatabaseClient) {}
  private org<T>(organizationId: string, fn: Parameters<typeof withOrganizationContext<T>>[1]) {
    return withOrganizationContext(organizationId, fn, { client: this.db });
  }

  async listForUser(organizationId: string, userId: string, connectionIds: string[]) {
    const ids = connectionIds.filter((c) => UUID_RE.test(c));
    if (ids.length === 0) return [];
    const rows = await this.org(organizationId, (tx) =>
      tx.calendarEventLink.findMany({
        where: {
          organizationId,
          userId,
          connectionId: { in: ids },
          unlinkedAt: null,
          meeting: { deletedAt: null },
        },
        select: {
          connectionId: true,
          providerEventId: true,
          meetingId: true,
          createdAt: true,
          updatedAt: true,
        },
        take: 5000,
      }),
    );
    return rows.map(({ providerEventId, ...r }) => ({ ...r, eventId: providerEventId }));
  }

  async matchExternalIds(organizationId: string, externalIds: string[]) {
    const ids = [...new Set(externalIds)].slice(0, MAX_MATCH_IDS);
    if (ids.length === 0) return new Map<string, string>();
    const rows = await this.org(organizationId, (tx) =>
      tx.meeting.findMany({
        where: { organizationId, deletedAt: null, externalMeetingId: { in: ids } },
        select: { id: true, externalMeetingId: true },
        take: MAX_MATCH_IDS * 4,
      }),
    );
    return uniqueMatches(rows);
  }

  async upsert(
    organizationId: string,
    userId: string,
    l: { connectionId: string; eventId: string; meetingId: string },
  ): Promise<CalendarEventLinkRow | null> {
    if (!UUID_RE.test(l.meetingId) || !UUID_RE.test(l.connectionId)) return null;
    return this.org(organizationId, async (tx) => {
      const meeting = await tx.meeting.findFirst({
        where: { id: l.meetingId, organizationId, deletedAt: null },
        select: { id: true },
      });
      if (!meeting) return null;
      const r = await tx.calendarEventLink.upsert({
        where: {
          organizationId_connectionId_providerEventId: {
            organizationId,
            connectionId: l.connectionId,
            providerEventId: l.eventId,
          },
        },
        create: {
          organizationId,
          userId,
          connectionId: l.connectionId,
          providerEventId: l.eventId,
          meetingId: l.meetingId,
          source: 'manual',
        },
        // A manual (re)link always wins: it replaces an auto link and revives one the user removed.
        update: { meetingId: l.meetingId, userId, source: 'manual', unlinkedAt: null },
      });
      return {
        connectionId: r.connectionId,
        eventId: r.providerEventId,
        meetingId: r.meetingId,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      };
    });
  }

  async remove(organizationId: string, userId: string, connectionId: string, eventId: string) {
    if (!UUID_RE.test(connectionId)) return false;
    const r = await this.org(organizationId, (tx) =>
      // Soft delete: the row stays as a tombstone so the worker's auto-link never recreates a link a user removed.
      tx.calendarEventLink.updateMany({
        where: { organizationId, userId, connectionId, providerEventId: eventId, unlinkedAt: null },
        data: { unlinkedAt: new Date() },
      }),
    );
    return r.count > 0;
  }

  async removeForConnection(organizationId: string, connectionId: string) {
    if (!UUID_RE.test(connectionId)) return;
    await this.org(organizationId, (tx) =>
      tx.calendarEventLink.deleteMany({ where: { organizationId, connectionId } }),
    );
  }
}

type MeetingRow = MeetingRecord & { deletedAt?: Date | null };

/** Dev/test only. Reads meetings from the in-memory meeting repository's rows. */
export class InMemoryCalendarEventLinks implements CalendarEventLinksRepository {
  readonly rows = new Map<
    string,
    CalendarEventLinkRow & {
      organizationId: string;
      userId: string;
      source?: 'manual' | 'auto';
      unlinkedAt?: Date | null;
    }
  >();
  constructor(
    private readonly meetings: () => Iterable<MeetingRow>,
    private readonly now: () => Date = () => new Date(),
  ) {}
  private key = (o: string, c: string, e: string) => `${o}\u0000${c}\u0000${e}`;
  private liveMeeting(organizationId: string, id: string) {
    for (const m of this.meetings())
      if (m.id === id && m.organizationId === organizationId && !m.deletedAt) return m;
    return undefined;
  }
  async listForUser(organizationId: string, userId: string, connectionIds: string[]) {
    return [...this.rows.values()]
      .filter(
        (r) =>
          r.organizationId === organizationId &&
          r.userId === userId &&
          connectionIds.includes(r.connectionId) &&
          !r.unlinkedAt &&
          this.liveMeeting(organizationId, r.meetingId),
      )
      .map((r) => ({
        connectionId: r.connectionId,
        eventId: r.eventId,
        meetingId: r.meetingId,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
  }
  async matchExternalIds(organizationId: string, externalIds: string[]) {
    const want = new Set(externalIds);
    return uniqueMatches(
      [...this.meetings()].filter(
        (m) =>
          m.organizationId === organizationId &&
          !m.deletedAt &&
          m.externalMeetingId !== null &&
          want.has(m.externalMeetingId),
      ),
    );
  }
  async upsert(
    organizationId: string,
    userId: string,
    l: { connectionId: string; eventId: string; meetingId: string },
  ) {
    if (!this.liveMeeting(organizationId, l.meetingId)) return null;
    const k = this.key(organizationId, l.connectionId, l.eventId);
    const t = this.now();
    const prev = this.rows.get(k);
    const row = {
      organizationId,
      userId,
      ...l,
      source: 'manual' as const,
      unlinkedAt: null,
      createdAt: prev?.createdAt ?? t,
      updatedAt: t,
    };
    this.rows.set(k, row);
    return { ...l, createdAt: row.createdAt, updatedAt: row.updatedAt };
  }
  async remove(organizationId: string, userId: string, connectionId: string, eventId: string) {
    const k = this.key(organizationId, connectionId, eventId);
    const r = this.rows.get(k);
    if (!r || r.userId !== userId || r.unlinkedAt) return false;
    r.unlinkedAt = this.now();
    return true;
  }
  async removeForConnection(organizationId: string, connectionId: string) {
    for (const [k, r] of this.rows)
      if (r.organizationId === organizationId && r.connectionId === connectionId)
        this.rows.delete(k);
  }
}
