import { withOrganizationContext, type DatabaseClient } from '@meetops/database';
import type { TranscriptionDeadLetter } from './transcription-retry.js';

/** Which DLQ entries to re-drive. Exactly one selector. */
export type RedriveFilter = { jobId: string } | { organizationId: string } | { all: true };

/** Minimal BullMQ surfaces (tests use fakes; the CLI passes real Queues). */
export type DlqJobLike = {
  id?: string | undefined;
  data: TranscriptionDeadLetter;
  remove(): Promise<void>;
};
export type OriginalJobLike = {
  getState(): Promise<string>;
  retry(
    state?: 'failed',
    opts?: { resetAttemptsMade?: boolean; resetAttemptsStarted?: boolean },
  ): Promise<void>;
};
export type RedriveQueues = {
  listDeadLetters(): Promise<DlqJobLike[]>;
  getTranscriptionJob(jobId: string): Promise<OriginalJobLike | undefined>;
};
/** Moves a meeting from `transcription_delayed` back to `processing`. Idempotent, org-scoped. */
export interface DelayedStatusReset {
  reset(organizationId: string, meetingId: string): Promise<void>;
}

export type RedriveAction =
  /** Original failed job retried with fresh attempts; DLQ entry removed. */
  | 'requeued'
  /** Original is already waiting/active/completed (an earlier run re-drove it); DLQ entry removed. */
  | 'already_requeued'
  /** Original job no longer exists (removeOnFail expired); DLQ entry kept for manual handling. */
  | 'missing_original'
  /** Dry run: would re-queue. */
  | 'would_requeue';

export type RedrivePlanItem = {
  dlqJobId: string | undefined;
  jobId: string | undefined;
  organizationId: string;
  meetingId: string;
  recordingId: string;
  errorCode: string;
  action: RedriveAction;
};

export type RedriveOptions = {
  filter: RedriveFilter;
  dryRun: boolean;
  /** Called once with the planned items before anything changes. Return false to abort. */
  confirm: (plan: RedrivePlanItem[]) => Promise<boolean>;
  status?: DelayedStatusReset | undefined;
};

export type RedriveReport = { aborted: boolean; items: RedrivePlanItem[] };

const ID_RE = /^[A-Za-z0-9:_-]{1,200}$/;
const UUID_RE = /^[0-9a-fA-F-]{36}$/;

/** Parse CLI args: `--job <id> | --org <uuid> | --all`, `--dry-run`, `--yes`. Throws on anything else. */
export function parseRedriveArgs(argv: string[]): {
  filter: RedriveFilter;
  dryRun: boolean;
  yes: boolean;
} {
  let filter: RedriveFilter | undefined;
  let dryRun = false;
  let yes = false;
  const set = (f: RedriveFilter) => {
    if (filter) throw new Error('use exactly one of --job, --org, --all');
    filter = f;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--yes') yes = true;
    else if (a === '--all') set({ all: true });
    else if (a === '--job') {
      const v = argv[++i];
      if (!v || !ID_RE.test(v)) throw new Error('--job needs a job id');
      set({ jobId: v });
    } else if (a === '--org') {
      const v = argv[++i];
      if (!v || !UUID_RE.test(v)) throw new Error('--org needs an organization uuid');
      set({ organizationId: v });
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (!filter) throw new Error('use exactly one of --job, --org, --all');
  return { filter, dryRun, yes };
}

const matches = (f: RedriveFilter, d: TranscriptionDeadLetter) =>
  'all' in f ? true : 'jobId' in f ? d.jobId === f.jobId : d.organizationId === f.organizationId;

/**
 * Re-drive dead-lettered transcription jobs. Safe to run twice: a DLQ entry is removed only after its original job
 * is retried (or found already re-queued), and an original that is not `failed` is never retried again.
 * The confirmation runs before any change; dry run never changes anything.
 */
export async function redriveTranscriptionDlq(
  queues: RedriveQueues,
  opts: RedriveOptions,
): Promise<RedriveReport> {
  const entries = (await queues.listDeadLetters()).filter((j) => matches(opts.filter, j.data));
  const planned: Array<{
    dlq: DlqJobLike;
    original: OriginalJobLike | undefined;
    item: RedrivePlanItem;
  }> = [];
  for (const dlq of entries) {
    const d = dlq.data;
    const original = d.jobId ? await queues.getTranscriptionJob(d.jobId) : undefined;
    const state = original ? await original.getState() : undefined;
    const action: RedriveAction = !original
      ? 'missing_original'
      : state === 'failed'
        ? opts.dryRun
          ? 'would_requeue'
          : 'requeued'
        : 'already_requeued';
    planned.push({
      dlq,
      original,
      item: {
        dlqJobId: dlq.id,
        jobId: d.jobId,
        organizationId: d.organizationId,
        meetingId: d.meetingId,
        recordingId: d.recordingId,
        errorCode: d.errorCode,
        action,
      },
    });
  }
  const items = planned.map((p) => p.item);
  if (opts.dryRun || items.length === 0) return { aborted: false, items };
  if (!(await opts.confirm(items))) return { aborted: true, items };

  for (const p of planned) {
    if (p.item.action === 'missing_original' || !p.original) continue;
    if (p.item.action === 'requeued') {
      // Re-check: another operator may have re-driven it since the plan was made.
      if ((await p.original.getState()) === 'failed')
        await p.original.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true });
      else p.item.action = 'already_requeued';
    }
    await opts.status?.reset(p.item.organizationId, p.item.meetingId);
    await p.dlq.remove();
  }
  return { aborted: false, items };
}

/** Postgres reset: only `transcription_delayed` -> `processing`, under forced RLS, filtered on organizationId. */
export function createPrismaDelayedStatusReset(
  opts: { client?: DatabaseClient } = {},
): DelayedStatusReset {
  return {
    reset: (organizationId, meetingId) =>
      withOrganizationContext(
        organizationId,
        async (tx) => {
          await tx.meeting.updateMany({
            where: {
              id: meetingId,
              organizationId,
              status: 'transcription_delayed',
              deletedAt: null,
            },
            data: { status: 'processing' },
          });
        },
        opts.client ? { client: opts.client } : {},
      ),
  };
}
