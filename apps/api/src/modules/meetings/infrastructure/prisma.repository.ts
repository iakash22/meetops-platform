import {
  isUniqueViolation,
  withOrganizationContext,
  type DatabaseClient,
} from '../../../shared/prisma/context.js';
import type {
  MeetingCreate,
  MeetingRecord,
  MeetingRepository,
  MeetingSource,
  MeetingStatus,
} from '../domain/meeting.js';
import { decodeMeetingCursor, encodeMeetingCursor } from './cursor.js';

const select = {
  id: true,
  organizationId: true,
  projectId: true,
  createdById: true,
  title: true,
  source: true,
  externalMeetingId: true,
  status: true,
  startedAt: true,
  endedAt: true,
  createdAt: true,
  updatedAt: true,
  deletedAt: true,
} as const;

interface Row {
  id: string;
  organizationId: string;
  projectId: string | null;
  createdById: string | null;
  title: string;
  source: string;
  externalMeetingId: string | null;
  status: string;
  startedAt: Date | null;
  endedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
}

const toRecord = ({ deletedAt, ...r }: Row): MeetingRecord => {
  void deletedAt;
  return { ...r, source: r.source as MeetingSource, status: r.status as MeetingStatus };
};

/**
 * Meetings on Prisma. Every call runs in withOrganizationContext (forced RLS on `meetings`) AND filters on
 * organizationId explicitly, so isolation holds even if RLS were bypassed.
 */
export class PrismaMeetingRepository implements MeetingRepository {
  constructor(private readonly client: DatabaseClient) {}

  private ctx<T>(organizationId: string, fn: Parameters<typeof withOrganizationContext<T>>[1]) {
    return withOrganizationContext(organizationId, fn, { client: this.client });
  }

  async list(
    organizationId: string,
    q: { cursor?: string | undefined; limit: number; source?: MeetingSource | undefined },
  ) {
    const after = q.cursor === undefined ? null : decodeMeetingCursor(q.cursor);
    const rows = await this.ctx(organizationId, (tx) =>
      tx.meeting.findMany({
        where: {
          organizationId,
          deletedAt: null,
          ...(q.source ? { source: q.source } : {}),
          ...(after
            ? {
                OR: [
                  { createdAt: { lt: after.createdAt } },
                  { createdAt: after.createdAt, id: { lt: after.id } },
                ],
              }
            : {}),
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: q.limit + 1,
        select,
      }),
    );
    const items = rows.slice(0, q.limit).map(toRecord);
    const last = items[items.length - 1];
    return { items, nextCursor: rows.length > q.limit && last ? encodeMeetingCursor(last) : null };
  }

  async findById(organizationId: string, id: string) {
    const row = await this.ctx(organizationId, (tx) =>
      tx.meeting.findFirst({ where: { id, organizationId, deletedAt: null }, select }),
    );
    return row ? toRecord(row) : null;
  }

  async resolve(organizationId: string, input: MeetingCreate) {
    const find = () =>
      this.ctx(organizationId, (tx) =>
        tx.meeting.findFirst({
          where: {
            organizationId,
            source: input.source,
            externalMeetingId: input.externalMeetingId,
          },
          select,
        }),
      );
    const existing = await find();
    if (existing) return { meeting: toRecord(existing), created: false };
    try {
      const row = await this.ctx(organizationId, (tx) =>
        tx.meeting.create({
          data: {
            organizationId,
            title: input.title,
            source: input.source,
            externalMeetingId: input.externalMeetingId,
            startedAt: input.startedAt,
            createdById: input.createdById,
          },
          select,
        }),
      );
      return { meeting: toRecord(row), created: true };
    } catch (e) {
      // Lost a concurrent race on the unique (org, source, external id): the winner's row is the answer.
      if (!isUniqueViolation(e)) throw e;
      const winner = await find();
      if (!winner) throw e;
      return { meeting: toRecord(winner), created: false };
    }
  }
}
