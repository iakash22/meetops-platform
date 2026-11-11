/**
 * Manual admin script: re-drive dead-lettered account-takeover follow-ups (#463 review).
 *   REDIS_URL=... [AUTH_MAIL_QUEUE_PREFIX=...] node apps/api/dist/scripts/takeover-dlq-redrive.js \
 *     (--job <id> | --user <id> | --kind <kind> | --all) [--apply [--yes]]
 * Dry run unless --apply. Uses the same Redis and key prefix as the API's auth-mail queue. Prints ids, the follow-up
 * kind and an error class only; never the Redis URL or payload dumps. See
 * docs/16-runbooks/takeover-follow-up-dlq-redrive.md.
 */
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import { Queue } from 'bullmq';
import type { TakeoverFollowUpJob } from '../modules/auth/domain/takeover-follow-up.js';
import { loadAuthMailQueueEnv } from '../modules/auth/infrastructure/mail-queue/env.js';
import {
  connectionOf,
  TAKEOVER_FOLLOW_UP_DLQ,
  TAKEOVER_FOLLOW_UP_JOB_OPTIONS,
  TAKEOVER_FOLLOW_UP_QUEUE,
  type TakeoverDeadLetter,
} from '../modules/auth/infrastructure/takeover-queue/bullmq-takeover-follow-up.js';
import {
  formatTakeoverRedriveItem,
  parseTakeoverRedriveArgs,
  redriveTakeoverFollowUpDlq,
  type TakeoverRedrivePlanItem,
  type TakeoverRedriveReport,
} from '../modules/auth/infrastructure/takeover-queue/dlq-redrive.js';

export type RedriveIo = {
  out(line: string): void;
  /** Asks for confirmation; resolves to the typed answer. */
  ask(question: string): Promise<string>;
};

/** Hides credentials in any URL an error message may echo (`scheme://user:pass@host` -> `scheme://***@host`). */
export const redactUrls = (s: string) => s.replace(/([a-z][a-z0-9+.-]*:\/\/)[^@\s/]*@/gi, '$1***@');

export async function main(
  env: Record<string, string | undefined>,
  argv: string[],
  io: RedriveIo,
): Promise<TakeoverRedriveReport> {
  const args = parseTakeoverRedriveArgs(argv.filter((a) => a !== '--'));
  const redisUrl = env.REDIS_URL?.trim();
  if (!redisUrl) throw new Error('REDIS_URL is required');
  const { prefix } = loadAuthMailQueueEnv(env); // validated; undefined = BullMQ default `bull`
  const opts = connectionOf({ redisUrl, prefix });
  const dlq = new Queue<TakeoverDeadLetter>(TAKEOVER_FOLLOW_UP_DLQ, opts);
  const queue = new Queue<TakeoverFollowUpJob>(TAKEOVER_FOLLOW_UP_QUEUE, opts);
  const print = (items: TakeoverRedrivePlanItem[]) => {
    for (const i of items) io.out(formatTakeoverRedriveItem(i));
    io.out(`${items.length} dead-letter entr${items.length === 1 ? 'y' : 'ies'} matched`);
  };
  io.out(
    `queue=${TAKEOVER_FOLLOW_UP_DLQ} prefix=${prefix ?? 'bull'} mode=${args.dryRun ? 'dry-run' : 'apply'}`,
  );
  try {
    const report = await redriveTakeoverFollowUpDlq(
      {
        listDeadLetters: async () =>
          await dlq.getJobs(['waiting', 'delayed', 'paused', 'prioritized', 'failed']),
        getFollowUpJob: async (id) => (await queue.getJob(id)) ?? undefined,
        enqueueFollowUp: async (job, jobId) => {
          await queue.add(job.kind, job, { ...TAKEOVER_FOLLOW_UP_JOB_OPTIONS, delay: 0, jobId });
        },
      },
      {
        filter: args.filter,
        dryRun: args.dryRun,
        confirm: async (plan) => {
          print(plan);
          if (args.yes) return true;
          return (
            (await io.ask('Re-drive the follow-ups above? Type "yes" to continue: ')).trim() ===
            'yes'
          );
        },
      },
    );
    if (args.dryRun || report.items.length === 0) {
      print(report.items);
      if (args.dryRun) io.out('Dry run: nothing changed. Re-run with --apply to re-drive.');
    } else if (report.aborted) io.out('Aborted; nothing changed.');
    else {
      io.out('Done.');
      print(report.items);
    }
    return report;
  } finally {
    await dlq.close();
    await queue.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const out = (line: string) => void process.stdout.write(`${line}\n`);
  main(process.env, process.argv.slice(2), {
    out,
    ask: async (q) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(q);
      } finally {
        rl.close();
      }
    },
  }).catch((err: unknown) => {
    process.stderr.write(
      `takeover:redrive failed: ${redactUrls(err instanceof Error ? err.message : 'unknown error')}\n`,
    );
    process.exitCode = 1;
  });
}
