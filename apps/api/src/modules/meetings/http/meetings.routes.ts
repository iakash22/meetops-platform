import type { FastifyInstance } from 'fastify';
import { Type, type Static } from '@sinclair/typebox';
import {
  CursorPage,
  CursorPageQuery,
  DEFAULT_PAGE_LIMIT,
  GetMeetingParams,
  Id,
  Meeting,
  ResolveMeetingRequest,
  ResolveMeetingResponse,
} from '@meetops/contracts';
import { directoryErrors, iso, type ResolveCaller } from '../../directory/http/route-kit.js';
import type { MeetingService } from '../application/meeting.service.js';
import type { MeetingRecord } from '../domain/meeting.js';

/** Route paths. Not in @meetops/contracts yet (no MEETING_PATHS constant); mirrors the web client. */
export const MEETING_PATHS = {
  meetings: '/orgs/:organizationId/meetings',
  meeting: '/orgs/:organizationId/meetings/:meetingId',
  resolve: '/orgs/:organizationId/meetings/resolve',
} as const;

export const MeetingsParams = Type.Object({ organizationId: Id }, { additionalProperties: false });
export type MeetingsParams = Static<typeof MeetingsParams>;
export const ListMeetingsQuery = CursorPageQuery;
export type ListMeetingsQuery = Static<typeof ListMeetingsQuery>;
export const ListMeetingsResponse = CursorPage(Meeting);

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
  opts: { meetings: MeetingService; caller: ResolveCaller },
) {
  const { meetings, caller } = opts;

  app.get<{ Params: MeetingsParams; Querystring: ListMeetingsQuery }>(
    MEETING_PATHS.meetings,
    {
      schema: {
        tags,
        summary: 'List meetings',
        description: 'Newest first (createdAt, id desc). Keyset cursor; limit 1..100, default 25.',
        params: MeetingsParams,
        querystring: ListMeetingsQuery,
        response: { 200: ListMeetingsResponse, ...directoryErrors },
      },
    },
    async (request) => {
      const c = await caller(request, request.params.organizationId);
      const { cursor, limit } = request.query;
      const page = await meetings.list(c, { cursor, limit: limit ?? DEFAULT_PAGE_LIMIT });
      return { items: page.items.map(toMeetingDto), nextCursor: page.nextCursor };
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
      const c = await caller(request, request.params.organizationId);
      const { meeting, created } = await meetings.resolve(c, request.body);
      return reply.code(created ? 201 : 200).send({ meetingId: meeting.id, created });
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
