import type { FastifyInstance } from 'fastify';
import { Type, type Static } from '@sinclair/typebox';
import {
  DEFAULT_PAGE_LIMIT,
  ANALYTICS_PATHS,
  GetMeetingParams,
  MAX_ANALYTICS_RANGE_DAYS,
  MeetingAnalytics,
  MeetingAnalyticsParams,
  MeetingAnalyticsQuery,
  Id,
  ListMeetingsQuery as ContractListMeetingsQuery,
  ListMeetingsResponse,
  Meeting,
  ResolveMeetingRequest,
  ResolveMeetingResponse,
} from '@meetops/contracts';
import { directoryErrors, iso, type ResolveCaller } from '../../directory/http/route-kit.js';
import type { MeetingService } from '../application/meeting.service.js';
import type { RouteLimiter } from '../../../shared/rate-limits.js';
import type { MeetingRecord } from '../domain/meeting.js';

/** Route paths. Not in @meetops/contracts yet (no MEETING_PATHS constant); mirrors the web client. */
export const MEETING_PATHS = {
  meetings: '/orgs/:organizationId/meetings',
  meeting: '/orgs/:organizationId/meetings/:meetingId',
  resolve: '/orgs/:organizationId/meetings/resolve',
} as const;

export const MeetingsParams = Type.Object({ organizationId: Id }, { additionalProperties: false });
export type MeetingsParams = Static<typeof MeetingsParams>;
/**
 * The contracts `ListMeetingsQuery` filters this route implements: `cursor`, `limit` and `source`. Other contract
 * filters (status, projectId, dates, q) are rejected with 400 rather than silently ignored.
 */
export const ListMeetingsQuery = Type.Pick(
  ContractListMeetingsQuery,
  ['cursor', 'limit', 'source'],
  {
    additionalProperties: false,
  },
);
export type ListMeetingsQuery = Static<typeof ListMeetingsQuery>;

/**
 * POST body, mirroring the web client (apps/web/src/features/meetings/manage-api.ts `MeetingInput`). Not in
 * @meetops/contracts yet. Strict: unknown fields (organizationId, source, status...) are 400 VALIDATION_FAILED.
 */
export const CreateMeetingBody = Type.Object(
  {
    title: Type.String({ minLength: 1, maxLength: 300, pattern: '\\S' }),
    startedAt: Type.Optional(Type.String({ format: 'date-time' })),
    projectId: Type.Optional(Id),
  },
  { additionalProperties: false },
);
export type CreateMeetingBody = Static<typeof CreateMeetingBody>;

export const toMeetingDto = (m: MeetingRecord): Meeting => ({
  id: m.id,
  organizationId: m.organizationId,
  ...(m.projectId ? { projectId: m.projectId } : {}),
  title: m.title,
  source: m.source,
  status: m.status,
  ...(m.startedAt ? { startedAt: iso(m.startedAt) } : {}),
  ...(m.endedAt ? { endedAt: iso(m.endedAt) } : {}),
  createdById: m.createdById,
  createdAt: iso(m.createdAt),
  updatedAt: iso(m.updatedAt),
});

const tags = ['meetings'];

export async function meetingRoutes(
  app: FastifyInstance,
  opts: {
    meetings: MeetingService;
    caller: ResolveCaller;
    /** Caller for `resolve` (cookie or ADR-005 extension bearer); defaults to `caller`. */
    resolveCaller?: ResolveCaller;
    /** ROUTE_RATE_LIMITS.analytics (shared with task analytics). */
    routeLimits?: RouteLimiter;
  },
) {
  const { meetings, caller, routeLimits } = opts;
  const resolveCaller = opts.resolveCaller ?? caller;

  app.get<{ Params: MeetingsParams; Querystring: ListMeetingsQuery }>(
    MEETING_PATHS.meetings,
    {
      schema: {
        tags,
        summary: 'List meetings',
        description:
          'Newest first (createdAt, id desc). Keyset cursor; limit 1..100, default 25. Optional `source` filter; the cursor is only valid for the same filter.',
        params: MeetingsParams,
        querystring: ListMeetingsQuery,
        response: { 200: ListMeetingsResponse, ...directoryErrors },
      },
    },
    async (request) => {
      const c = await caller(request, request.params.organizationId);
      const { cursor, limit, source } = request.query;
      // Always scoped to the caller's organization (service + repository); `source` only narrows within it.
      const page = await meetings.list(c, { cursor, limit: limit ?? DEFAULT_PAGE_LIMIT, source });
      return { items: page.items.map(toMeetingDto), nextCursor: page.nextCursor };
    },
  );

  app.post<{ Params: MeetingsParams; Body: CreateMeetingBody }>(
    MEETING_PATHS.meetings,
    {
      schema: {
        tags,
        summary: 'Create a meeting',
        description:
          'Manual meeting (web "New meeting"). source upload, status scheduled; projectId must be a live project of the organization (else 400). Owner/admin/member; viewer 403; other orgs 404. CSRF, rate limited per caller and per org (429), audit-logged (meeting.create).',
        params: MeetingsParams,
        body: CreateMeetingBody,
        response: { 201: Meeting, ...directoryErrors },
      },
    },
    async (request, reply) => {
      const c = await caller(request, request.params.organizationId);
      const m = await meetings.create(c, request.body);
      return reply.code(201).send(toMeetingDto(m));
    },
  );

  app.post<{ Params: MeetingsParams; Body: ResolveMeetingRequest }>(
    MEETING_PATHS.resolve,
    {
      schema: {
        tags,
        summary: 'Find or create the meeting for an external call',
        description:
          'Idempotent per (organizationId, source, externalMeetingId). 201 + created:true when inserted, 200 + created:false when it already existed. Owner/admin/member; viewer 403.',
        params: MeetingsParams,
        body: ResolveMeetingRequest,
        response: { 200: ResolveMeetingResponse, 201: ResolveMeetingResponse, ...directoryErrors },
      },
    },
    async (request, reply) => {
      const c = await resolveCaller(request, request.params.organizationId);
      const { meeting, created } = await meetings.resolve(c, request.body);
      return reply.code(created ? 201 : 200).send({ meetingId: meeting.id, created });
    },
  );

  app.get<{ Params: MeetingAnalyticsParams; Querystring: MeetingAnalyticsQuery }>(
    ANALYTICS_PATHS.meetings,
    {
      schema: {
        tags: ['analytics'],
        summary: 'Meeting analytics',
        description: `Read-only aggregates for the organization: counts by source, status and UTC period, and duration totals. createdAt in [from, to), at most ${MAX_ANALYTICS_RANGE_DAYS} days; bucket day|week|month (default day). Viewer and up; other orgs 404.`,
        params: MeetingAnalyticsParams,
        querystring: MeetingAnalyticsQuery,
        response: { 200: MeetingAnalytics, ...directoryErrors },
      },
    },
    async (request, reply) => {
      const c = await caller(request, request.params.organizationId);
      await routeLimits?.charge('analytics', c.ctx);
      const r = await meetings.analytics(c, request.query);
      void reply.header('cache-control', 'private, no-store');
      return {
        organizationId: c.ctx.organizationId,
        from: iso(r.from),
        to: iso(r.to),
        bucket: r.bucket,
        total: r.total,
        bySource: r.bySource,
        byStatus: r.byStatus,
        duration: r.duration,
        periods: r.periods.map((p) => ({ start: iso(p.start), count: p.count })),
      };
    },
  );

  app.get<{ Params: GetMeetingParams }>(
    MEETING_PATHS.meeting,
    {
      schema: {
        tags,
        summary: 'Get meeting',
        description: 'Missing, deleted and other-organization ids all return the same 404.',
        params: GetMeetingParams,
        response: { 200: Meeting, ...directoryErrors },
      },
    },
    async (request) => {
      const c = await caller(request, request.params.organizationId);
      return toMeetingDto(await meetings.get(c, request.params.meetingId));
    },
  );
}
