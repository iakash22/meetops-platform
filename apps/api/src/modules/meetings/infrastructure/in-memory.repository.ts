import { randomUUID } from 'node:crypto';
import {
  bucketStart,
  type MeetingAnalyticsQuery,
  type MeetingAnalyticsResult,
} from '../domain/meeting.js';
import { MeetingProjectInvalidError } from '../domain/meeting.js';
import type {
  ManualMeetingCreate,
  MeetingCreate,
  MeetingPage,
  MeetingRecord,
  MeetingRepository,
  MeetingSource,
} from '../domain/meeting.js';
import { compareDesc, decodeMeetingCursor, encodeMeetingCursor } from './cursor.js';

type Row = MeetingRecord & { deletedAt: Date | null; durationSec?: number | null };

/** Development/test only (selectMeetingRepository refuses it in strict environments). */
export class InMemoryMeetingRepository implements MeetingRepository {
  readonly rows = new Map<string, Row>();
  /**
   * Live projects as `${organizationId}:${projectId}`. Undefined: projectId is not checked (no in-memory projects
   * store is shared with this repository); tests set it to exercise the same 400 as Prisma.
   */
  projects: Set<string> | undefined;
  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Test seam: insert a row directly (e.g. an upload meeting or a soft-deleted one). */
  seed(row: Partial<Row> & Pick<Row, 'organizationId'>): Row {
    const t = this.now();
    const r: Row = {
      id: randomUUID(),
      projectId: null,
      createdById: null,
      title: 'Meeting',
      source: 'upload',
      externalMeetingId: null,
      status: 'scheduled',
      startedAt: null,
      endedAt: null,
      createdAt: t,
      updatedAt: t,
      deletedAt: null,
      ...row,
    };
    this.rows.set(r.id, r);
    return r;
  }

  private live(organizationId: string) {
    return [...this.rows.values()].filter(
      (r) => r.organizationId === organizationId && r.deletedAt === null,
    );
  }

  list(
    organizationId: string,
    q: { cursor?: string | undefined; limit: number; source?: MeetingSource | undefined },
  ): Promise<MeetingPage> {
    try {
      const after = q.cursor === undefined ? null : decodeMeetingCursor(q.cursor);
      const sorted = this.live(organizationId)
        .filter((r) => q.source === undefined || r.source === q.source)
        .sort(compareDesc);
      const rest = after ? sorted.filter((r) => compareDesc(r, after) > 0) : sorted;
      const items = rest.slice(0, q.limit).map(strip);
      const last = items[items.length - 1];
      return Promise.resolve({
        items,
        nextCursor: rest.length > q.limit && last ? encodeMeetingCursor(last) : null,
      });
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  }

  findById(organizationId: string, id: string): Promise<MeetingRecord | null> {
    const r = this.rows.get(id);
    return Promise.resolve(
      r && r.organizationId === organizationId && r.deletedAt === null ? strip(r) : null,
    );
  }

  analytics(organizationId: string, q: MeetingAnalyticsQuery): Promise<MeetingAnalyticsResult> {
    const rows = this.live(organizationId).filter(
      (r) => r.createdAt >= q.from && r.createdAt < q.to,
    );
    const count = <K extends string>(key: (r: Row) => K) => {
      const m = new Map<K, number>();
      for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
      return [...m].sort(([a], [b]) => a.localeCompare(b));
    };
    const measured = rows.filter((r) => typeof r.durationSec === 'number');
    const totalSec = measured.reduce((n, r) => n + (r.durationSec ?? 0), 0);
    const periods = new Map<number, number>();
    for (const r of rows) {
      const k = bucketStart(r.createdAt, q.bucket).getTime();
      periods.set(k, (periods.get(k) ?? 0) + 1);
    }
    return Promise.resolve({
      total: rows.length,
      bySource: count((r) => r.source).map(([source, n]) => ({
        source: source,
        count: n,
      })),
      byStatus: count((r) => r.status).map(([status, n]) => ({
        status: status,
        count: n,
      })),
      duration: {
        measured: measured.length,
        totalSec,
        averageSec: measured.length ? totalSec / measured.length : null,
      },
      periods: [...periods]
        .sort(([a], [b]) => a - b)
        .map(([t, n]) => ({ start: new Date(t), count: n })),
    });
  }

  resolve(organizationId: string, input: MeetingCreate) {
    // Soft-deleted rows still hold the unique key (like the DB index), so a deleted meeting is not resurrected
    // under a new id; it resolves to a 404-able id the caller cannot read.
    const existing = [...this.rows.values()].find(
      (r) =>
        r.organizationId === organizationId &&
        r.source === input.source &&
        r.externalMeetingId === input.externalMeetingId,
    );
    if (existing) return Promise.resolve({ meeting: strip(existing), created: false });
    const row = this.seed({ organizationId, ...input, status: 'scheduled' });
    return Promise.resolve({ meeting: strip(row), created: true });
  }

  create(organizationId: string, input: ManualMeetingCreate): Promise<MeetingRecord> {
    if (
      input.projectId &&
      this.projects &&
      !this.projects.has(`${organizationId}:${input.projectId}`)
    )
      return Promise.reject(new MeetingProjectInvalidError());
    const row = this.seed({ organizationId, ...input, status: 'scheduled' });
    return Promise.resolve(strip(row));
  }
}

function strip(r: Row): MeetingRecord {
  const { deletedAt, durationSec, ...rest } = r;
  void deletedAt;
  void durationSec;
  return { ...rest };
}
