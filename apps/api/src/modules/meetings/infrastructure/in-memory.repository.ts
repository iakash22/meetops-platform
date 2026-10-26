import { randomUUID } from 'node:crypto';
import type {
  MeetingCreate,
  MeetingPage,
  MeetingRecord,
  MeetingRepository,
} from '../domain/meeting.js';
import { compareDesc, decodeMeetingCursor, encodeMeetingCursor } from './cursor.js';

type Row = MeetingRecord & { deletedAt: Date | null };

/** Development/test only (selectMeetingRepository refuses it in strict environments). */
export class InMemoryMeetingRepository implements MeetingRepository {
  readonly rows = new Map<string, Row>();
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
    q: { cursor?: string | undefined; limit: number },
  ): Promise<MeetingPage> {
    try {
      const after = q.cursor === undefined ? null : decodeMeetingCursor(q.cursor);
      const sorted = this.live(organizationId).sort(compareDesc);
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
}

function strip(r: Row): MeetingRecord {
  const { deletedAt, ...rest } = r;
  void deletedAt;
  return { ...rest };
}
