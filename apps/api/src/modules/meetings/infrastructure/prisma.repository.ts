import {
  isUniqueViolation,
  withOrganizationContext,
  type DatabaseClient,
} from '../../../shared/prisma/context.js';
import { MeetingProjectInvalidError } from '../domain/meeting.js';
import type {
  ManualMeetingCreate,
  MeetingAnalyticsQuery,
  MeetingAnalyticsResult,
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

  /**
   * Aggregate-only reads in ONE org-context transaction (forced RLS) plus an explicit org_id filter. The bucket is
   * one of three literals from the validated query and is still bound as a parameter, never interpolated.
   */
  async analytics(
    organizationId: string,
    q: MeetingAnalyticsQuery,
  ): Promise<MeetingAnalyticsResult> {
    const where = { organizationId, deletedAt: null, createdAt: { gte: q.from, lt: q.to } };
    return this.ctx(organizationId, async (tx) => {
      const bySource = await tx.meeting.groupBy({
        by: ['source'],
        where,
        _count: { _all: true },
      });
      const byStatus = await tx.meeting.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
      });
      const agg = await tx.meeting.aggregate({
        where: { ...where, durationSec: { not: null } },
        _count: { _all: true },
        _sum: { durationSec: true },
      });
      const periods = await tx.$queryRaw<{ start: Date; count: bigint }[]>`
        SELECT date_trunc(${q.bucket}::text, created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS start,
               count(*) AS count
          FROM meetings
         WHERE org_id = ${organizationId}::uuid
           AND deleted_at IS NULL
           AND created_at >= ${q.from}
           AND created_at < ${q.to}
         GROUP BY 1
         ORDER BY 1`;
      const measured = agg._count._all;
      const totalSec = agg._sum.durationSec ?? 0;
      return {
        total: bySource.reduce((n, r) => n + r._count._all, 0),
        // Alphabetical, like the in-memory adapter (Postgres would order enums by declaration).
        bySource: bySource
          .map((r) => ({
            source: r.source,
            count: r._count._all,
          }))
          .sort((x, y) => x.source.localeCompare(y.source)),
        byStatus: byStatus
          .map((r) => ({
            status: r.status,
            count: r._count._all,
          }))
          .sort((x, y) => x.status.localeCompare(y.status)),
        duration: { measured, totalSec, averageSec: measured ? totalSec / measured : null },
        periods: periods.map((p) => ({ start: new Date(p.start), count: Number(p.count) })),
      };
    });
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

  /** One org-context transaction (forced RLS): the project check and the insert see the same tenant. */
  async create(organizationId: string, input: ManualMeetingCreate) {
    const row = await this.ctx(organizationId, async (tx) => {
      if (
        input.projectId &&
        !(await tx.project.findFirst({
          where: { organizationId, id: input.projectId, deletedAt: null },
          select: { id: true },
        }))
      )
        throw new MeetingProjectInvalidError();
      return tx.meeting.create({
        data: {
          organizationId,
          title: input.title,
          source: input.source,
          startedAt: input.startedAt,
          projectId: input.projectId,
          createdById: input.createdById,
        },
        select,
      });
    });
    return toRecord(row);
  }
}
