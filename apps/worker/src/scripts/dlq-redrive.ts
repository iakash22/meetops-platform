/**
 * Manual admin script: re-drive dead-lettered transcription jobs.
 *   pnpm --filter @meetops/worker dlq:redrive -- (--job <id> | --org <uuid> | --all) [--dry-run] [--yes]
 * Prints ids and error codes only. See docs/16-runbooks/transcription-dlq-redrive.md.
 */
import { createInterface } from 'node:readline/promises';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { QUEUE_NAMES } from '@meetops/contracts';
import { disconnectPrismaClient } from '@meetops/database';
import {
  createPrismaDelayedStatusReset,
  parseRedriveArgs,
  redriveTranscriptionDlq,
  type RedrivePlanItem,
} from '../ai/dlq-redrive.js';
import { TRANSCRIPTION_DLQ } from '../ai/transcription-retry.js';

const out = (line: string) => void process.stdout.write(`${line}\n`);
const print = (items: RedrivePlanItem[]) => {
  for (const i of items)
    out(
      `${i.action.padEnd(17)} job=${i.jobId ?? '-'} org=${i.organizationId} meeting=${i.meetingId} code=${i.errorCode}`,
    );
  out(`${items.length} dead-letter entr${items.length === 1 ? 'y' : 'ies'} matched`);
};

async function main() {
  const args = parseRedriveArgs(process.argv.slice(2).filter((a) => a !== '--'));
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
  const conn = new Redis(redisUrl, { maxRetriesPerRequest: null });
  const dlq = new Queue(TRANSCRIPTION_DLQ, { connection: conn });
  const transcription = new Queue(QUEUE_NAMES.transcription, { connection: conn });
  try {
    const report = await redriveTranscriptionDlq(
      {
        listDeadLetters: async () =>
          await dlq.getJobs(['waiting', 'delayed', 'paused', 'prioritized']),
        getTranscriptionJob: async (id) => (await transcription.getJob(id)) ?? undefined,
      },
      {
        filter: args.filter,
        dryRun: args.dryRun,
        status: args.dryRun ? undefined : createPrismaDelayedStatusReset(),
        confirm: async (plan) => {
          print(plan);
          if (args.yes) return true;
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const answer = await rl.question('Re-queue the jobs above? Type "yes" to continue: ');
          rl.close();
          return answer.trim() === 'yes';
        },
      },
    );
    if (args.dryRun || report.items.length === 0) print(report.items);
    else if (report.aborted) out('Aborted; nothing changed.');
    else {
      out('Done.');
      print(report.items);
    }
  } finally {
    await dlq.close();
    await transcription.close();
    conn.disconnect();
    await disconnectPrismaClient().catch(() => undefined);
  }
}

main().catch((err: unknown) => {
  console.error(`dlq:redrive failed: ${err instanceof Error ? err.message : 'unknown error'}`);
  process.exitCode = 1;
});
