import { describe, expect, it, vi } from 'vitest';
import {
  parseRedriveArgs,
  redriveTranscriptionDlq,
  type DlqJobLike,
  type OriginalJobLike,
  type RedriveQueues,
} from '../src/ai/dlq-redrive.js';
import type { TranscriptionDeadLetter } from '../src/ai/transcription-retry.js';

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '44444444-4444-4444-8444-444444444444';
const MEET = '22222222-2222-4222-8222-222222222222';

const letter = (jobId: string, organizationId = ORG_A): TranscriptionDeadLetter => ({
  organizationId,
  meetingId: MEET,
  recordingId: '33333333-3333-4333-8333-333333333333',
  chunkIndex: 0,
  jobId,
  errorCode: 'provider_retryable',
  attemptsMade: 6,
  failedAt: '2026-11-03T12:00:00.000Z',
});

/** In-memory DLQ + transcription queue that behave like BullMQ for the calls used. */
function fakeQueues(letters: TranscriptionDeadLetter[], states: Record<string, string>) {
  const dlq = new Map<string, TranscriptionDeadLetter>(letters.map((l) => [`dlq:${l.jobId}`, l]));
  const retried: string[] = [];
  const original = (id: string): OriginalJobLike => ({
    getState: async () => states[id]!,
    retry: vi.fn(async (_s, opts) => {
      expect(opts).toEqual({ resetAttemptsMade: true, resetAttemptsStarted: true });
      if (states[id] !== 'failed') throw new Error('not failed');
      states[id] = 'waiting';
      retried.push(id);
    }),
  });
  const queues: RedriveQueues = {
    listDeadLetters: async () =>
      [...dlq.entries()].map(([id, data]): DlqJobLike => ({
        id,
        data,
        remove: async () => void dlq.delete(id),
      })),
    getTranscriptionJob: async (id) => (id in states ? original(id) : undefined),
  };
  return { queues, dlq, retried, states };
}

const yes = async () => true;

describe('parseRedriveArgs', () => {
  it('accepts one selector plus flags', () => {
    expect(parseRedriveArgs(['--job', 'transcribe:abc:0', '--dry-run'])).toEqual({
      filter: { jobId: 'transcribe:abc:0' },
      dryRun: true,
      yes: false,
    });
    expect(parseRedriveArgs(['--org', ORG_A, '--yes']).filter).toEqual({ organizationId: ORG_A });
    expect(parseRedriveArgs(['--all']).filter).toEqual({ all: true });
  });
  it.each([[[]], [['--all', '--org', ORG_A]], [['--org', 'nope']], [['--job']], [['--force']]])(
    'rejects %j',
    (argv) => expect(() => parseRedriveArgs(argv)).toThrow(),
  );
});

describe('redriveTranscriptionDlq', () => {
  it('dry run reports the plan and changes nothing', async () => {
    const f = fakeQueues([letter('j1'), letter('j2')], { j1: 'failed', j2: 'completed' });
    const confirm = vi.fn(yes);
    const r = await redriveTranscriptionDlq(f.queues, {
      filter: { all: true },
      dryRun: true,
      confirm,
    });
    expect(r.items.map((i) => i.action)).toEqual(['would_requeue', 'already_requeued']);
    expect(confirm).not.toHaveBeenCalled();
    expect(f.retried).toEqual([]);
    expect(f.dlq.size).toBe(2);
  });

  it('asks for confirmation; a "no" changes nothing', async () => {
    const f = fakeQueues([letter('j1')], { j1: 'failed' });
    const r = await redriveTranscriptionDlq(f.queues, {
      filter: { all: true },
      dryRun: false,
      confirm: async () => false,
    });
    expect(r.aborted).toBe(true);
    expect(f.retried).toEqual([]);
    expect(f.dlq.size).toBe(1);
  });

  it('re-queues failed originals with fresh attempts, resets status, removes the DLQ entry', async () => {
    const f = fakeQueues([letter('j1')], { j1: 'failed' });
    const status = { reset: vi.fn(async () => undefined) };
    const r = await redriveTranscriptionDlq(f.queues, {
      filter: { jobId: 'j1' },
      dryRun: false,
      confirm: yes,
      status,
    });
    expect(r.items[0]!.action).toBe('requeued');
    expect(f.retried).toEqual(['j1']);
    expect(status.reset).toHaveBeenCalledWith(ORG_A, MEET);
    expect(f.dlq.size).toBe(0);
  });

  it('is safe to run twice', async () => {
    const f = fakeQueues([letter('j1')], { j1: 'failed' });
    const opts = { filter: { all: true as const }, dryRun: false, confirm: yes };
    await redriveTranscriptionDlq(f.queues, opts);
    const second = await redriveTranscriptionDlq(f.queues, opts);
    expect(second.items).toEqual([]);
    expect(f.retried).toEqual(['j1']);
  });

  it('a crash after retry but before DLQ removal does not retry again', async () => {
    const f = fakeQueues([letter('j1')], { j1: 'waiting' }); // already re-driven by a previous run
    const r = await redriveTranscriptionDlq(f.queues, {
      filter: { all: true },
      dryRun: false,
      confirm: yes,
    });
    expect(r.items[0]!.action).toBe('already_requeued');
    expect(f.retried).toEqual([]);
    expect(f.dlq.size).toBe(0);
  });

  it('filters by organization and keeps entries whose original is gone', async () => {
    const f = fakeQueues([letter('j1'), letter('j2', ORG_B), letter('gone')], {
      j1: 'failed',
      j2: 'failed',
    });
    const r = await redriveTranscriptionDlq(f.queues, {
      filter: { organizationId: ORG_A },
      dryRun: false,
      confirm: yes,
    });
    expect(r.items.map((i) => [i.jobId, i.action])).toEqual([
      ['j1', 'requeued'],
      ['gone', 'missing_original'],
    ]);
    expect(f.retried).toEqual(['j1']);
    expect([...f.dlq.keys()].sort()).toEqual(['dlq:gone', 'dlq:j2']);
  });

  it('re-checks state at apply time (another operator re-drove it meanwhile)', async () => {
    const f = fakeQueues([letter('j1')], { j1: 'failed' });
    const r = await redriveTranscriptionDlq(f.queues, {
      filter: { all: true },
      dryRun: false,
      confirm: async () => {
        f.states.j1 = 'active';
        return true;
      },
    });
    expect(r.items[0]!.action).toBe('already_requeued');
    expect(f.retried).toEqual([]);
  });
});
