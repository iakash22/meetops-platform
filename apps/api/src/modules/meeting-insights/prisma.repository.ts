import { Value } from '@sinclair/typebox/value';
import {
  ReportContent,
  type Report,
  type Transcript,
  type TranscriptProviderId,
} from '@meetops/contracts';
import { withOrganizationContext, type DatabaseClient } from '../../shared/prisma/context.js';
import type { MeetingInsightsRepository } from './ports.js';

const PROVIDERS = new Set<string>(['assemblyai', 'faster-whisper', 'deepgram', 'unknown']);

/**
 * Prisma reads in one `withOrganizationContext` transaction each (forced RLS), also filtered on organizationId.
 * Transcript revision 0 is the worker's per-recording chunk anchor and is never returned; revisions >= 1 are merged.
 */
export class PrismaMeetingInsights implements MeetingInsightsRepository {
  constructor(private readonly db: DatabaseClient) {}

  meetingExists(organizationId: string, meetingId: string) {
    return withOrganizationContext(
      organizationId,
      async (tx) =>
        !!(await tx.meeting.findFirst({
          where: { id: meetingId, organizationId, deletedAt: null },
          select: { id: true },
        })),
      { client: this.db },
    );
  }

  latestTranscript(organizationId: string, meetingId: string): Promise<Transcript | null> {
    return withOrganizationContext(
      organizationId,
      async (tx) => {
        const recording = await tx.recording.findFirst({
          where: {
            organizationId,
            meetingId,
            deletedAt: null,
            transcripts: { some: { revision: { gt: 0 }, deletedAt: null } },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          select: { id: true },
        });
        if (!recording) return null;
        const t = await tx.transcript.findFirst({
          where: {
            organizationId,
            meetingId,
            recordingId: recording.id,
            revision: { gt: 0 },
            deletedAt: null,
          },
          orderBy: { revision: 'desc' },
          select: {
            id: true,
            meetingId: true,
            recordingId: true,
            provider: true,
            providerJobId: true,
            language: true,
            revision: true,
            createdAt: true,
          },
        });
        if (!t) return null;
        const segments = await tx.transcriptSegment.findMany({
          where: { organizationId, transcriptId: t.id, revision: t.revision },
          orderBy: { sequence: 'asc' },
          select: {
            id: true,
            sequence: true,
            startMs: true,
            endMs: true,
            speakerLabel: true,
            text: true,
            confidence: true,
          },
        });
        return {
          id: t.id,
          meetingId: t.meetingId,
          recordingId: t.recordingId,
          ...(t.language ? { language: t.language } : {}),
          provider: (PROVIDERS.has(t.provider) ? t.provider : 'unknown') as TranscriptProviderId,
          ...(t.providerJobId ? { providerJobId: t.providerJobId } : {}),
          segments: segments.map((s) => ({
            id: s.id,
            index: s.sequence,
            startMs: s.startMs,
            endMs: Math.max(s.startMs, s.endMs),
            ...(s.speakerLabel ? { speaker: s.speakerLabel } : {}),
            text: s.text,
            ...(s.confidence !== null && s.confidence >= 0 && s.confidence <= 1
              ? { confidence: s.confidence }
              : {}),
          })),
          createdAt: t.createdAt.toISOString(),
        };
      },
      { client: this.db },
    );
  }

  latestReport(organizationId: string, meetingId: string): Promise<Report | null> {
    return withOrganizationContext(
      organizationId,
      async (tx) => {
        const rows = await tx.report.findMany({
          where: { organizationId, meetingId, deletedAt: null, status: { not: 'archived' } },
          orderBy: { version: 'desc' },
          take: 5,
          select: { id: true, meetingId: true, content: true, aiRunId: true, createdAt: true },
        });
        // Validate on read (ReportContent): a malformed row is skipped rather than sent to the client.
        for (const r of rows) {
          if (!Value.Check(ReportContent, r.content)) continue;
          const c = r.content;
          return {
            id: r.id,
            organizationId,
            meetingId: r.meetingId,
            summary: c.summary,
            decisions: c.decisions,
            risks: c.risks,
            actionItems: c.actionItems,
            aiRunId: r.aiRunId,
            createdAt: r.createdAt.toISOString(),
          };
        }
        return null;
      },
      { client: this.db },
    );
  }
}
