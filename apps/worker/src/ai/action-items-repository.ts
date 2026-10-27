import {
  withOrganizationContext,
  type DatabaseClient,
  type DatabaseTransaction,
} from '@meetops/database';
import {
  EXTRACTED_TASKS_EVENT,
  EXTRACTED_TASKS_NOTIFICATION_KIND,
  type ActionItemsRepository,
  type ExtractionKey,
} from './action-items.js';

const KIND = 'task_extraction' as const;

const findRun = async (tx: DatabaseTransaction, organizationId: string, k: ExtractionKey) => {
  const runs = await tx.aiRun.findMany({
    where: {
      organizationId,
      meetingId: k.meetingId,
      transcriptId: k.transcriptId,
      transcriptRevision: k.transcriptRevision,
      promptVersion: k.promptVersion,
      kind: KIND,
      status: 'succeeded',
    },
    select: { id: true, metadata: true },
  });
  return runs.find((r) => (r.metadata as { reportId?: unknown } | null)?.reportId === k.reportId);
};

/**
 * Prisma implementation under forced RLS (`withOrganizationContext`). A transaction-scoped advisory lock on the
 * extraction key serialises concurrent writers, so retries/duplicate jobs never double-insert drafts.
 */
export function createPrismaActionItemsRepository(
  opts: { client?: DatabaseClient; timeoutMs?: number } = {},
): ActionItemsRepository {
  const inOrg = <T>(organizationId: string, fn: (tx: DatabaseTransaction) => Promise<T>) =>
    withOrganizationContext(organizationId, fn, {
      ...(opts.client ? { client: opts.client } : {}),
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });
  return {
    findExtraction: (organizationId, key) =>
      inOrg(organizationId, async (tx) => {
        const r = await findRun(tx, organizationId, key);
        return r ? { aiRunId: r.id } : undefined;
      }),
    saveExtraction: (organizationId, w) =>
      inOrg(organizationId, async (tx) => {
        const lockKey = `${KIND}:${organizationId}:${w.reportId}:${w.transcriptRevision}:${w.promptVersion}`;
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
        const existing = await findRun(tx, organizationId, w);
        if (existing) return { aiRunId: existing.id, created: false, tasksCreated: 0 };
        const now = new Date();
        const run = await tx.aiRun.create({
          data: {
            organizationId,
            meetingId: w.meetingId,
            transcriptId: w.transcriptId,
            transcriptRevision: w.transcriptRevision,
            kind: KIND,
            provider: w.provider,
            model: w.model,
            promptVersion: w.promptVersion,
            status: 'succeeded',
            inputTokens: w.usage.inputTokens,
            outputTokens: w.usage.outputTokens,
            totalTokens: w.usage.totalTokens,
            latencyMs: w.latencyMs,
            metadata: { reportId: w.reportId, items: w.tasks.length },
            startedAt: new Date(now.getTime() - w.latencyMs),
            completedAt: now,
          },
          select: { id: true },
        });
        if (w.tasks.length > 0) {
          await tx.extractedTask.createMany({
            data: w.tasks.map((t) => ({
              organizationId,
              meetingId: w.meetingId,
              reportId: w.reportId,
              aiRunId: run.id,
              title: t.title,
              description: t.description,
              priority: t.priority,
              assigneeHint: t.assigneeHint,
              dueHint: t.dueHint,
              confidence: t.confidence,
              sourceSegmentIds: t.sourceSegmentIds,
              // Never auto-approved: a human accepts via AcceptExtractedTaskRequest.
              status: 'pending_review' as const,
            })),
          });
          // Same transaction as the drafts: the notification fan-out sees the event iff the drafts exist.
          // Ids + counts only; no transcript or model text.
          await tx.outboxEvent.create({
            data: {
              organizationId,
              aggregateType: 'meeting',
              aggregateId: w.meetingId,
              eventType: EXTRACTED_TASKS_EVENT,
              payload: {
                kind: EXTRACTED_TASKS_NOTIFICATION_KIND,
                meetingId: w.meetingId,
                reportId: w.reportId,
                aiRunId: run.id,
                count: w.tasks.length,
              },
            },
          });
        }
        return { aiRunId: run.id, created: true, tasksCreated: w.tasks.length };
      }),
  };
}
