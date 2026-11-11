import {
  TAKEOVER_FOLLOW_UP_KINDS,
  isTakeoverFollowUpKind,
  type TakeoverFollowUpJob,
  type TakeoverFollowUpKind,
} from '../../domain/takeover-follow-up.js';
import {
  TAKEOVER_JOB_ID_RE,
  takeoverDeadLetterJobId,
  takeoverFollowUpJobId,
  validJob,
} from './bullmq-takeover-follow-up.js';

/**
 * Re-drive of dead-lettered account-takeover follow-ups (`auth-takeover-follow-up-dlq`, entries `dlq_<jobId>`).
 * Mirrors the worker's transcription DLQ re-drive (apps/worker/src/ai/dlq-redrive.ts), with two differences:
 * - the original job may be gone (completed jobs are removed at once, failed ones after 7 days). Every follow-up
 *   kind is idempotent, so a fresh job is enqueued under the same deterministic job id instead;
 * - an entry whose payload does not validate, or whose ids do not match `takeover_<kind>_<sha256>` for that
 *   payload, is reported and kept: it is never used to retry or enqueue anything.
 * See docs/16-runbooks/takeover-follow-up-dlq-redrive.md.
 */

/** Which DLQ entries to re-drive. Exactly one selector. */
export type TakeoverRedriveFilter =
  { jobId: string } | { userId: string } | { kind: TakeoverFollowUpKind } | { all: true };

/** Minimal BullMQ surfaces (tests use fakes; the CLI passes real Queues). */
export type TakeoverDlqEntryLike = {
  id?: string | undefined;
  data: unknown;
  remove(): Promise<void>;
};
export type TakeoverOriginalJobLike = {
  getState(): Promise<string>;
  retry(
    state?: 'failed',
    opts?: { resetAttemptsMade?: boolean; resetAttemptsStarted?: boolean },
  ): Promise<void>;
};
export type TakeoverRedriveQueues = {
  listDeadLetters(): Promise<TakeoverDlqEntryLike[]>;
  getFollowUpJob(jobId: string): Promise<TakeoverOriginalJobLike | undefined>;
  /** Adds `job` under `jobId` to run now. BullMQ dedupes on the id, so a repeat is a no-op. */
  enqueueFollowUp(job: TakeoverFollowUpJob, jobId: string): Promise<void>;
};

export type TakeoverRedriveAction =
  /** Original failed job retried with fresh attempts; DLQ entry removed. */
  | 'requeued'
  /** Original job no longer exists; a fresh job was added under the same id; DLQ entry removed. */
  | 'enqueued'
  /** Original is already waiting/delayed/active (an earlier run re-drove it); DLQ entry removed. */
  | 'already_requeued'
  /** Payload or ids do not validate; DLQ entry kept for manual handling, nothing enqueued. */
  | 'invalid_payload'
  /** Dry run: would retry the failed original. */
  | 'would_requeue'
  /** Dry run: would enqueue a fresh job. */
  | 'would_enqueue'
  /** Dry run: original already pending; would only remove the DLQ entry. */
  | 'would_drop_duplicate';

export type TakeoverRedrivePlanItem = {
  dlqJobId: string | undefined;
  jobId: string | undefined;
  userId: string | undefined;
  kind: TakeoverFollowUpKind | undefined;
  attemptsMade: number | undefined;
  errorType: string;
  action: TakeoverRedriveAction;
};

export type TakeoverRedriveOptions = {
  filter: TakeoverRedriveFilter;
  /** True unless `--apply` was given: nothing changes. */
  dryRun: boolean;
  /** Called once with the planned items before anything changes. Return false to abort. */
  confirm: (plan: TakeoverRedrivePlanItem[]) => Promise<boolean>;
};

export type TakeoverRedriveReport = { aborted: boolean; items: TakeoverRedrivePlanItem[] };

const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DLQ_ID_RE = new RegExp(`^dlq_takeover_(${TAKEOVER_FOLLOW_UP_KINDS.join('|')})_[0-9a-f]{40}$`);
const SAFE_CODE_RE = /^[\w.-]{1,64}$/;
/** BullMQ states in which the original will still run (or is running): re-driving it again would double-run. */
const PENDING_STATES = new Set([
  'waiting',
  'delayed',
  'active',
  'prioritized',
  'paused',
  'waiting-children',
]);

/**
 * Parse CLI args: `--job <id> | --user <id> | --kind <kind> | --all`, then `--apply` (default is a dry run),
 * `--dry-run` (explicit, wins over --apply) and `--yes`. Throws on anything else.
 */
export function parseTakeoverRedriveArgs(argv: string[]): {
  filter: TakeoverRedriveFilter;
  dryRun: boolean;
  yes: boolean;
} {
  let filter: TakeoverRedriveFilter | undefined;
  let apply = false;
  let forceDry = false;
  let yes = false;
  const set = (f: TakeoverRedriveFilter) => {
    if (filter) throw new Error('use exactly one of --job, --user, --kind, --all');
    filter = f;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') apply = true;
    else if (a === '--dry-run') forceDry = true;
    else if (a === '--yes') yes = true;
    else if (a === '--all') set({ all: true });
    else if (a === '--job') {
      const v = argv[++i];
      if (!v || !(TAKEOVER_JOB_ID_RE.test(v) || DLQ_ID_RE.test(v)))
        throw new Error('--job needs a takeover_<kind>_<hash> or dlq_takeover_… id');
      set({ jobId: v });
    } else if (a === '--user') {
      const v = argv[++i];
      if (!v || !USER_ID_RE.test(v)) throw new Error('--user needs a user id');
      set({ userId: v });
    } else if (a === '--kind') {
      const v = argv[++i];
      if (!isTakeoverFollowUpKind(v))
        throw new Error(`--kind needs ${TAKEOVER_FOLLOW_UP_KINDS.join(', ')}`);
      set({ kind: v });
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (!filter) throw new Error('use exactly one of --job, --user, --kind, --all');
  return { filter, dryRun: forceDry || !apply, yes };
}

type Checked = {
  entry: TakeoverDlqEntryLike;
  job: TakeoverFollowUpJob | undefined;
  jobId: string | undefined;
  item: Omit<TakeoverRedrivePlanItem, 'action'>;
};

/** Validates one DLQ entry: payload shape, and that both ids are the deterministic ones for that payload. */
function check(entry: TakeoverDlqEntryLike): Checked {
  const raw = (entry.data && typeof entry.data === 'object' ? entry.data : {}) as Record<
    string,
    unknown
  >;
  const job = validJob(raw) ?? undefined;
  const expectedId = job ? takeoverFollowUpJobId(job) : undefined;
  const ok =
    !!job &&
    raw.jobId === expectedId &&
    entry.id === takeoverDeadLetterJobId(expectedId!) &&
    (raw.attemptsMade === undefined || Number.isInteger(raw.attemptsMade));
  const errorType =
    typeof raw.errorType === 'string' && SAFE_CODE_RE.test(raw.errorType)
      ? raw.errorType
      : 'unknown';
  return {
    entry,
    job: ok ? job : undefined,
    jobId: ok ? expectedId : undefined,
    item: {
      dlqJobId: entry.id && DLQ_ID_RE.test(entry.id) ? entry.id : undefined,
      jobId: ok ? expectedId : undefined,
      userId: ok ? job.userId : undefined,
      kind: ok ? job.kind : undefined,
      attemptsMade: ok && typeof raw.attemptsMade === 'number' ? raw.attemptsMade : undefined,
      errorType,
    },
  };
}

/** `--job` matches the original job id or the DLQ id. Invalid entries match only `--all` or their DLQ id. */
function matches(f: TakeoverRedriveFilter, c: Checked): boolean {
  if ('all' in f) return true;
  if ('jobId' in f) return c.jobId === f.jobId || (!!c.entry.id && c.entry.id === f.jobId);
  if (!c.job) return false;
  if ('userId' in f) return c.job.userId === f.userId;
  return c.job.kind === f.kind;
}

async function stateOf(queues: TakeoverRedriveQueues, jobId: string) {
  const original = await queues.getFollowUpJob(jobId);
  const state = original ? await original.getState() : undefined;
  return { original, state: state === 'unknown' ? undefined : state };
}

const plannedAction = (state: string | undefined, dryRun: boolean): TakeoverRedriveAction => {
  if (state === 'failed') return dryRun ? 'would_requeue' : 'requeued';
  if (state && (PENDING_STATES.has(state) || state === 'completed'))
    return dryRun ? 'would_drop_duplicate' : 'already_requeued';
  return dryRun ? 'would_enqueue' : 'enqueued';
};

/**
 * Re-drive dead-lettered takeover follow-ups. Safe to run twice: a DLQ entry is removed only after its follow-up is
 * retried, enqueued or found already pending; a pending original is never retried again, and an enqueue reuses the
 * deterministic job id, so BullMQ dedupes concurrent runs. Confirmation runs before any change; a dry run changes
 * nothing.
 */
export async function redriveTakeoverFollowUpDlq(
  queues: TakeoverRedriveQueues,
  opts: TakeoverRedriveOptions,
): Promise<TakeoverRedriveReport> {
  const checked = (await queues.listDeadLetters())
    .map(check)
    .filter((c) => matches(opts.filter, c));
  const planned: Array<Checked & { item: TakeoverRedrivePlanItem }> = [];
  for (const c of checked) {
    const action: TakeoverRedriveAction = !c.jobId
      ? 'invalid_payload'
      : plannedAction((await stateOf(queues, c.jobId)).state, opts.dryRun);
    planned.push({ ...c, item: { ...c.item, action } });
  }
  const items = planned.map((p) => p.item);
  if (opts.dryRun || items.length === 0) return { aborted: false, items };
  if (!(await opts.confirm(items))) return { aborted: true, items };

  for (const p of planned) {
    if (p.item.action === 'invalid_payload' || !p.job || !p.jobId) continue;
    // Re-check: another operator or the worker may have moved it since the plan was made.
    const { original, state } = await stateOf(queues, p.jobId);
    const action = plannedAction(state, false);
    if (action === 'requeued')
      await original!.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true });
    else if (action === 'enqueued') await queues.enqueueFollowUp(p.job, p.jobId);
    p.item.action = action;
    await p.entry.remove();
  }
  return { aborted: false, items };
}

/** One output line per item: ids, kind and a safe error class only (no payload dump, no connection details). */
export function formatTakeoverRedriveItem(i: TakeoverRedrivePlanItem): string {
  return `${i.action.padEnd(20)} dlq=${i.dlqJobId ?? '-'} kind=${i.kind ?? '-'} user=${i.userId ?? '-'} attempts=${
    i.attemptsMade ?? '-'
  } error=${i.errorType}`;
}
