import type { FastifyInstance } from 'fastify';
import { Type } from '@sinclair/typebox';
import { Report, Transcript } from '@meetops/contracts';
import type { AuthService } from '../auth/application/auth.service.js';
import { makeGuards, requestMeta } from '../auth/http/security.js';
import { registerDomainErrorHandler } from '../../shared/http-errors.js';
import type { OrganizationService } from '../organizations/application/organization.service.js';
import { isRelaxedEnv, MissingProductionDependencyError, type ModuleDeps } from '../index.js';
import { DirectoryAccess } from '../directory/access.js';
import { directoryErrors } from '../directory/http/route-kit.js';
import { MeetingNotFoundError, ReportNotReadyError, TranscriptNotReadyError } from './errors.js';
import { InMemoryMeetingInsights } from './in-memory.repository.js';
import { PrismaMeetingInsights } from './prisma.repository.js';
import type { MeetingInsightsRepository } from './ports.js';

/**
 * Proposed paths (web PR #172 builds against these). Contracts 0.4.x define the DTOs but no path constants;
 * move these into @meetops/contracts with the next contracts minor.
 */
export const MEETING_INSIGHTS_PATHS = {
  transcript: '/orgs/:organizationId/meetings/:meetingId/transcript',
  report: '/orgs/:organizationId/meetings/:meetingId/report',
} as const;

const Params = Type.Object(
  { organizationId: Type.String({ format: 'uuid' }), meetingId: Type.String({ format: 'uuid' }) },
  { additionalProperties: false },
);
type Params = { organizationId: string; meetingId: string };

export type MeetingInsightsModuleDeps = ModuleDeps & {
  meetingInsights?: MeetingInsightsRepository;
};

export function selectMeetingInsightsRepository(
  deps: MeetingInsightsModuleDeps,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): MeetingInsightsRepository {
  if (deps.meetingInsights) return deps.meetingInsights;
  if (deps.db) return new PrismaMeetingInsights(deps.db);
  if (!isRelaxedEnv(nodeEnv)) throw new MissingProductionDependencyError(['meetingInsights']);
  return new InMemoryMeetingInsights();
}

/**
 * Phase 3: read a meeting's transcript and report. Order: session (401) -> active org + membership (404) ->
 * CASL read Meeting (403) -> meeting exists in this org (404) -> latest artifact (404 until ready).
 */
export default async function meetingInsightsModule(
  app: FastifyInstance,
  opts: { auth: AuthService; organizations: OrganizationService; deps: MeetingInsightsModuleDeps },
) {
  const { auth, organizations, deps } = opts;
  const repo = selectMeetingInsightsRepository(deps);
  registerDomainErrorHandler(app);
  const g = makeGuards(auth, deps.security);
  const access = new DirectoryAccess(organizations, deps.audit);

  async function readableMeeting(request: Parameters<typeof g.requireSession>[0], p: Params) {
    const c = await access.caller(
      await g.requireSession(request),
      p.organizationId,
      requestMeta(request),
    );
    organizations.authorize(c.ctx, 'read', 'Meeting');
    if (!(await repo.meetingExists(c.ctx.organizationId, p.meetingId)))
      throw new MeetingNotFoundError();
    return c.ctx.organizationId;
  }

  app.get<{ Params: Params }>(
    MEETING_INSIGHTS_PATHS.transcript,
    {
      schema: {
        tags: ['meetings'],
        summary: 'Get the latest merged transcript of a meeting',
        description:
          '404 until a merged transcript revision exists (the client shows "not ready yet").',
        params: Params,
        response: { 200: Transcript, ...directoryErrors },
      },
    },
    async (request) => {
      const orgId = await readableMeeting(request, request.params);
      const t = await repo.latestTranscript(orgId, request.params.meetingId);
      if (!t) throw new TranscriptNotReadyError();
      return t;
    },
  );

  app.get<{ Params: Params }>(
    MEETING_INSIGHTS_PATHS.report,
    {
      schema: {
        tags: ['meetings'],
        summary: 'Get the latest report of a meeting',
        description:
          '404 until a report exists. Action item hints are UNTRUSTED LLM output (display only).',
        params: Params,
        response: { 200: Report, ...directoryErrors },
      },
    },
    async (request) => {
      const orgId = await readableMeeting(request, request.params);
      const r = await repo.latestReport(orgId, request.params.meetingId);
      if (!r) throw new ReportNotReadyError();
      return r;
    },
  );
}
