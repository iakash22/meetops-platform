import {
  withOrganizationContext,
  type DatabaseClient,
  type DatabaseTransaction,
} from '@meetops/database';
import type { ReportContent, TaskPriority } from '@meetops/contracts';

export type SummarySegment = {
  id: string;
  sequence: number;
  speakerLabel: string | null;
  startMs: number;
  endMs: number;
  text: string;
};

export type SummaryTranscript = {
  transcriptId: string;
  recordingId: string;
  revision: number;
  language: string | null;
  segments: SummarySegment[];
};

export type ExtractedTaskWrite = {
  title: string;
  description: string | null;
  priority: TaskPriority;
  assigneeHint: string | null;
  dueHint: string | null;
  confidence: number;
  sourceSegmentIds: string[];
};

export type SummaryRunKey = {
  meetingId: string;
  transcriptId: string;
  transcriptRevision: number;
  promptVersion: string;
};

export type SummaryWrite = SummaryRunKey & {
  provider: string;
  model: string;
  usage: { inputTokens: number | null; outputTokens: number | null; totalTokens: number | null };
  latencyMs: number;
  title: string | null;
  content: ReportContent;
  tasks: ExtractedTaskWrite[];
};

export type SummaryFailureWrite = SummaryRunKey & {
  provider: string;
  model: string;
  errorCode: string;
};

export interface OrgScopedSummaryRepository {
  findMeeting(meetingId: string): Promise<{ id: string; organizationId: string } | undefined>;
  /** Latest `ready` merged transcript (revision >= 1) of the meeting, with segment row ids. */
  latestReadyTranscript(meetingId: string): Promise<SummaryTranscript | undefined>;
  /** Report already produced for this exact (transcript, revision, prompt version), if any. */
  findSummary(key: SummaryRunKey): Promise<{ reportId: string } | undefined>;
  /**
   * One transaction: AiRun(succeeded) + Report(next version) + ExtractedTask rows, all `pending_review`.
   * Returns created=false when a concurrent writer already stored this key.
   */
  saveSummary(write: SummaryWrite): Promise<{ reportId: string; created: boolean }>;
  recordFailure(write: SummaryFailureWrite): Promise<void>;
}

export interface SummaryRepository {
  withOrgContext<T>(
    organizationId: string,
    fn: (repo: OrgScopedSummaryRepository) => Promise<T>,
  ): Promise<T>;
}

const SUMMARY_KIND = 'summary' as const;

export function createOrgScopedSummaryRepository(
  tx: DatabaseTransaction,
  organizationId: string,
): OrgScopedSummaryRepository {
  const findRun = (k: SummaryRunKey) =>
    tx.aiRun.findFirst({
      where: {
        organizationId,
        meetingId: k.meetingId,
        transcriptId: k.transcriptId,
        transcriptRevision: k.transcriptRevision,
        promptVersion: k.promptVersion,
        kind: SUMMARY_KIND,
        status: 'succeeded',
      },
      select: {
        reports: { where: { organizationId, deletedAt: null }, select: { id: true }, take: 1 },
      },
    });

  return {
    async findMeeting(meetingId) {
      const m = await tx.meeting.findFirst({
        where: { id: meetingId, organizationId, deletedAt: null },
        select: { id: true, organizationId: true },
      });
      return m ?? undefined;
    },
    async latestReadyTranscript(meetingId) {
      const t = await tx.transcript.findFirst({
        where: { organizationId, meetingId, revision: { gt: 0 }, status: 'ready', deletedAt: null },
        orderBy: [{ createdAt: 'desc' }, { revision: 'desc' }],
        select: { id: true, recordingId: true, revision: true, language: true },
      });
      if (!t) return undefined;
      const segments = await tx.transcriptSegment.findMany({
        where: { organizationId, transcriptId: t.id, revision: t.revision },
        orderBy: { sequence: 'asc' },
        select: {
          id: true,
          sequence: true,
          speakerLabel: true,
          startMs: true,
          endMs: true,
          text: true,
        },
      });
      return {
        transcriptId: t.id,
        recordingId: t.recordingId,
        revision: t.revision,
        language: t.language,
        segments,
      };
    },
    async findSummary(key) {
      const run = await findRun(key);
      const id = run?.reports[0]?.id;
      return id ? { reportId: id } : undefined;
    },
    async saveSummary(w) {
      const existing = await findRun(w);
      const existingId = existing?.reports[0]?.id;
      if (existingId) return { reportId: existingId, created: false };
      const now = new Date();
      const run = await tx.aiRun.create({
        data: {
          organizationId,
          meetingId: w.meetingId,
          transcriptId: w.transcriptId,
          transcriptRevision: w.transcriptRevision,
          kind: SUMMARY_KIND,
          provider: w.provider,
          model: w.model,
          promptVersion: w.promptVersion,
          status: 'succeeded',
          inputTokens: w.usage.inputTokens,
          outputTokens: w.usage.outputTokens,
          totalTokens: w.usage.totalTokens,
          latencyMs: w.latencyMs,
          startedAt: new Date(now.getTime() - w.latencyMs),
          completedAt: now,
        },
        select: { id: true },
      });
      const last = await tx.report.findFirst({
        where: { organizationId, meetingId: w.meetingId },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const report = await tx.report.create({
        data: {
          organizationId,
          meetingId: w.meetingId,
          transcriptId: w.transcriptId,
          aiRunId: run.id,
          version: (last?.version ?? 0) + 1,
          status: 'draft',
          title: w.title,
          summary: w.content.summary,
          content: w.content,
        },
        select: { id: true },
      });
      if (w.tasks.length > 0)
        await tx.extractedTask.createMany({
          data: w.tasks.map((t) => ({
            organizationId,
            meetingId: w.meetingId,
            reportId: report.id,
            aiRunId: run.id,
            title: t.title,
            description: t.description,
            priority: t.priority,
            assigneeHint: t.assigneeHint,
            dueHint: t.dueHint,
            confidence: t.confidence,
            sourceSegmentIds: t.sourceSegmentIds,
            // Never auto-approved: a human decides through the approval API.
            status: 'pending_review' as const,
          })),
        });
      return { reportId: report.id, created: true };
    },
    async recordFailure(w) {
      await tx.aiRun.create({
        data: {
          organizationId,
          meetingId: w.meetingId,
          transcriptId: w.transcriptId,
          transcriptRevision: w.transcriptRevision,
          kind: SUMMARY_KIND,
          provider: w.provider,
          model: w.model,
          promptVersion: w.promptVersion,
          status: 'failed',
          error: w.errorCode,
          completedAt: new Date(),
        },
      });
    },
  };
}

export function createPrismaSummaryRepository(
  opts: { client?: DatabaseClient; timeoutMs?: number } = {},
): SummaryRepository {
  return {
    withOrgContext: (organizationId, fn) =>
      withOrganizationContext(
        organizationId,
        (tx) => fn(createOrgScopedSummaryRepository(tx, organizationId)),
        {
          ...(opts.client ? { client: opts.client } : {}),
          ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
        },
      ),
  };
}
