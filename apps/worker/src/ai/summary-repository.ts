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
   * One transaction: AiRun(succeeded) + Report(next version) + ExtractedTask rows, all `pending_review`,
   * + a `meeting.summary_ready` outbox event (ids/counts only).
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
  /**
   * Saves in its own org transaction. A unique violation (concurrent writer stored the same
   * reports_summary_dedupe_key) is treated as already done: the existing report is returned with created=false.
   */
  saveSummary(
    organizationId: string,
    write: SummaryWrite,
  ): Promise<{ reportId: string; created: boolean }>;
}

/** Prisma P2002 / Postgres 23505. Duck-typed: Prisma reports `meta.target: null` for composite keys. */
export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { code?: unknown; meta?: { code?: unknown } };
  return e.code === 'P2002' || e.code === '23505' || e.meta?.code === '23505';
}

/**
 * Shared save path. The failed statement aborts the Postgres transaction (AiRun insert rolls back too), so the
 * re-read runs in a fresh transaction. Any other unique conflict (e.g. a concurrent report `version`) is rethrown
 * and the job retries.
 */
export async function saveSummaryOnce(
  repo: Pick<SummaryRepository, 'withOrgContext'>,
  organizationId: string,
  write: SummaryWrite,
): Promise<{ reportId: string; created: boolean }> {
  try {
    return await repo.withOrgContext(organizationId, (r) => r.saveSummary(write));
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const existing = await repo.withOrgContext(organizationId, (r) => r.findSummary(write));
    if (existing) return { reportId: existing.reportId, created: false };
    throw err;
  }
}

const SUMMARY_KIND = 'summary' as const;

/** Outbox event the notifications relay (#279) fans out as `meeting.summary_ready`. Ids/counts only. */
export const SUMMARY_READY_EVENT = 'meeting.summary_ready';

export function createOrgScopedSummaryRepository(
  tx: DatabaseTransaction,
  organizationId: string,
): OrgScopedSummaryRepository {
  /** Dedupe lookup by the reports_summary_dedupe_key columns. Includes soft-deleted rows (they still hold the key). */
  const findReport = (k: SummaryRunKey) =>
    tx.report.findFirst({
      where: {
        organizationId,
        meetingId: k.meetingId,
        transcriptId: k.transcriptId,
        transcriptRevision: k.transcriptRevision,
        promptVersion: k.promptVersion,
      },
      select: { id: true },
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
      const r = await findReport(key);
      return r ? { reportId: r.id } : undefined;
    },
    async saveSummary(w) {
      const existing = await findReport(w);
      if (existing) return { reportId: existing.id, created: false };
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
          transcriptRevision: w.transcriptRevision,
          promptVersion: w.promptVersion,
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
      // Same transaction as the report: the notification fan-out sees the event iff the summary exists.
      // Org-scoped (RLS); ids + counts only, never summary/transcript/model text.
      await tx.outboxEvent.create({
        data: {
          organizationId,
          aggregateType: 'meeting',
          aggregateId: w.meetingId,
          eventType: SUMMARY_READY_EVENT,
          payload: {
            meetingId: w.meetingId,
            reportId: report.id,
            transcriptRevision: w.transcriptRevision,
            tasksPendingReview: w.tasks.length,
          },
        },
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
  const repo: SummaryRepository = {
    saveSummary: (organizationId, write) => saveSummaryOnce(repo, organizationId, write),
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
  return repo;
}
