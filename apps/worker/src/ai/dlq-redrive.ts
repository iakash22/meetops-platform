import { withOrganizationContext, type DatabaseClient } from '@meetops/database';
import {
  deadLetterJobId,
  meetingHasDeadLetters,
  type TranscriptionDeadLetter,
} from './transcription-retry.js';

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

/** `--job` accepts the original transcription job id or the DLQ id (`dlq_…`, see deadLetterJobId). */
const matches = (f: RedriveFilter, j: DlqJobLike) => {
  const d = j.data;
  if ('all' in f) return true;
  if ('organizationId' in f) return d.organizationId === f.organizationId;
  return (
    d.jobId === f.jobId ||
    j.id === f.jobId ||
    deadLetterJobId(d.jobId, d.recordingId, d.chunkIndex) === f.jobId
  );
};
const meetingKey = (d: { organizationId: string; meetingId: string }) =>
  `${d.organizationId}/${d.meetingId}`;

/**
 * Re-drive dead-lettered transcription jobs. Safe to run twice: a DLQ entry is removed only after its original job
 * is retried (or found already re-queued), and an original that is not `failed` is never retried again.
 * The confirmation runs before any change; dry run never changes anything.
 */
export async function redriveTranscriptionDlq(
  queues: RedriveQueues,
  opts: RedriveOptions,
): Promise<RedriveReport> {
  const entries = (await queues.listDeadLetters()).filter((j) => matches(opts.filter, j));
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

  const requeuedMeetings = new Map<string, { organizationId: string; meetingId: string }>();
  for (const p of planned) {
    if (p.item.action === 'missing_original' || !p.original) continue;
    if (p.item.action === 'requeued') {
      // Re-check: another operator may have re-driven it since the plan was made.
      if ((await p.original.getState()) === 'failed') {
        await p.original.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true });
        requeuedMeetings.set(meetingKey(p.item), p.item);
      } else p.item.action = 'already_requeued';
    }
    await p.dlq.remove();
  }
  // Reset a meeting to `processing` only when THIS run re-queued one of its jobs (never for already_requeued) AND no
  // other chunk of that meeting is still dead-lettered (re-read after removals, so it also sees concurrent entries
  // and entries this run kept, e.g. missing_original or outside the filter).
  if (opts.status && requeuedMeetings.size > 0) {
    // Same guard as the worker's success path (#414): meetingHasDeadLetters.
    const remaining = await queues.listDeadLetters();
    for (const m of requeuedMeetings.values())
      if (!meetingHasDeadLetters(remaining, m.organizationId, m.meetingId))
        await opts.status.reset(m.organizationId, m.meetingId);
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
