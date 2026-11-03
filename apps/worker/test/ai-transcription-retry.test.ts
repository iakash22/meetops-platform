import { describe, expect, it, vi } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import {
  DEFAULT_TRANSCRIPTION_RETRY,
  TRANSCRIPTION_BACKOFF_TYPE,
  TRANSCRIPTION_DLQ,
  DLQ_JOB_ID_PREFIX,
  deadLetterJobId,
  handleTranscriptionFailure,
  handleTranscriptionSuccess,
  meetingHasDeadLetters,
  isRetryExhausted,
  transcriptionBackoffMs,
  transcriptionBackoffStrategy,
  transcriptionJobOptions,
  type DeadLetterQueueLike,
} from '../src/ai/transcription-retry.js';
import { loadTranscriptionWorkerEnv, TranscriptionWorkerEnvError } from '../src/ai/env.js';
import { TranscriptionJobError } from '../src/ai/consumer.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const MEET = '22222222-2222-4222-8222-222222222222';
const REC = '33333333-3333-4333-8333-333333333333';
const policy = { attempts: 4, baseDelayMs: 1_000, maxDelayMs: 10_000 };

describe('transcription backoff', () => {
  it('grows exponentially, with equal jitter in [exp/2, exp]', () => {
    expect(transcriptionBackoffMs(1, policy, () => 0)).toBe(500);
    expect(transcriptionBackoffMs(1, policy, () => 1)).toBe(1_000);
    expect(transcriptionBackoffMs(2, policy, () => 1)).toBe(2_000);
    expect(transcriptionBackoffMs(3, policy, () => 0.5)).toBe(3_000);
  });
  it('is capped at maxDelayMs', () => {
    expect(transcriptionBackoffMs(20, policy, () => 1)).toBe(10_000);
    expect(transcriptionBackoffMs(1_000, policy, () => 0)).toBe(5_000);
  });
  it('clamps bad random values and attempt counts', () => {
    expect(transcriptionBackoffMs(0, policy, () => 5)).toBe(1_000);
    expect(transcriptionBackoffMs(1, policy, () => -1)).toBe(500);
  });
  it('strategy applies the policy', () => {
    const s = transcriptionBackoffStrategy(policy, () => 1);
    expect(s(2)).toBe(2_000);
    expect(s(9)).toBe(10_000);
  });
  it('job options use the policy attempts and the custom backoff', () => {
    expect(transcriptionJobOptions(policy)).toMatchObject({
      attempts: 4,
      backoff: { type: TRANSCRIPTION_BACKOFF_TYPE },
    });
    expect(transcriptionJobOptions().attempts).toBe(DEFAULT_TRANSCRIPTION_RETRY.attempts);
  });
});

describe('transcription retry env', () => {
  it('defaults', () => {
    expect(loadTranscriptionWorkerEnv({}).retry).toEqual(DEFAULT_TRANSCRIPTION_RETRY);
  });
  it('reads overrides', () => {
    expect(
      loadTranscriptionWorkerEnv({
        TRANSCRIPTION_MAX_ATTEMPTS: '3',
        TRANSCRIPTION_BACKOFF_BASE_MS: '2000',
        TRANSCRIPTION_BACKOFF_MAX_MS: '60000',
      }).retry,
    ).toEqual({ attempts: 3, baseDelayMs: 2_000, maxDelayMs: 60_000 });
  });
  it('rejects out-of-range and inconsistent values', () => {
    expect(() => loadTranscriptionWorkerEnv({ TRANSCRIPTION_MAX_ATTEMPTS: '0' })).toThrow(
      TranscriptionWorkerEnvError,
    );
    expect(() => loadTranscriptionWorkerEnv({ TRANSCRIPTION_MAX_ATTEMPTS: 'x' })).toThrow(
      TranscriptionWorkerEnvError,
    );
    expect(() =>
      loadTranscriptionWorkerEnv({
        TRANSCRIPTION_BACKOFF_BASE_MS: '50000',
        TRANSCRIPTION_BACKOFF_MAX_MS: '10000',
      }),
    ).toThrow(TranscriptionWorkerEnvError);
  });
});

describe('dead-lettering', () => {
  const job = (attemptsMade: number, attempts = 4) => ({
    id: 'job-1',
    data: { organizationId: ORG, meetingId: MEET, recordingId: REC, chunkIndex: 2 },
    attemptsMade,
    opts: { attempts },
  });
  const setup = () => {
    const dlq = { add: vi.fn<DeadLetterQueueLike['add']>(async () => undefined) };
    const status = {
      markDelayed: vi.fn(async () => undefined),
      clearDelayed: vi.fn(async () => undefined),
    };
    const alert = vi.fn();
    const logger = { warn: vi.fn(), error: vi.fn() };
    const deps = { dlq, status, alert, logger, now: () => new Date('2026-11-03T12:00:00Z') };
    return { dlq, status, alert, logger, deps };
  };
  const outage = new TranscriptionJobError('provider_retryable', true);

  it('does nothing while retries remain', async () => {
    const { deps, dlq, status, alert } = setup();
    expect(await handleTranscriptionFailure(job(2), outage, deps)).toBe(false);
    expect(dlq.add).not.toHaveBeenCalled();
    expect(status.markDelayed).not.toHaveBeenCalled();
    expect(alert).not.toHaveBeenCalled();
  });

  it('never dead-letters permanent (unrecoverable) errors', async () => {
    const { deps, dlq } = setup();
    const err = new UnrecoverableError('transcription job failed: invalid_payload');
    expect(isRetryExhausted(job(1), err)).toBe(false);
    expect(await handleTranscriptionFailure(job(4), err, deps)).toBe(false);
    expect(dlq.add).not.toHaveBeenCalled();
  });

  it('on the last attempt: DLQ entry (ids + code only), delayed status, alert', async () => {
    const { deps, dlq, status, alert, logger } = setup();
    expect(await handleTranscriptionFailure(job(4), outage, deps)).toBe(true);
    const entry = {
      organizationId: ORG,
      meetingId: MEET,
      recordingId: REC,
      chunkIndex: 2,
      jobId: 'job-1',
      errorCode: 'provider_retryable',
      attemptsMade: 4,
      failedAt: '2026-11-03T12:00:00.000Z',
    };
    expect(dlq.add).toHaveBeenCalledWith('transcription_dead_letter', entry, {
      jobId: 'dlq_job-1',
      removeOnComplete: false,
      removeOnFail: false,
    });
    expect(status.markDelayed).toHaveBeenCalledWith(ORG, MEET);
    expect(alert).toHaveBeenCalledWith(entry);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, errorCode: 'provider_retryable' }),
      expect.stringContaining('transcription delayed'),
    );
  });

  it('one failing step does not stop the others', async () => {
    const { deps, dlq, status, alert, logger } = setup();
    dlq.add.mockRejectedValueOnce(new Error('redis down'));
    status.markDelayed.mockRejectedValueOnce(new Error('db down'));
    alert.mockRejectedValueOnce(new Error('hook down'));
    expect(await handleTranscriptionFailure(job(4), outage, deps)).toBe(true);
    expect(status.markDelayed).toHaveBeenCalled();
    expect(alert).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('unknown errors map to provider_unavailable; jobs without ids are ignored', async () => {
    const { deps, dlq } = setup();
    await handleTranscriptionFailure(job(4), new Error('boom'), deps);
    expect(dlq.add.mock.calls[0]![1].errorCode).toBe('provider_unavailable');
    expect(
      await handleTranscriptionFailure({ attemptsMade: 9, opts: { attempts: 1 } }, outage, deps),
    ).toBe(false);
    expect(await handleTranscriptionFailure(undefined, outage, deps)).toBe(false);
  });

  it('DLQ job ids never contain ":" (BullMQ 5.81 rejects them) and use the dlq_ prefix', () => {
    expect(deadLetterJobId('job-1', REC, 2)).toBe('dlq_job-1');
    expect(deadLetterJobId('a:b:c', REC, 2)).toBe('dlq_a_b_c');
    expect(deadLetterJobId(undefined, REC, 3)).toBe(`dlq_${REC}_3`);
    expect(deadLetterJobId(undefined, REC, undefined)).toBe(`dlq_${REC}_0`);
    for (const id of [deadLetterJobId('x:y', REC, 1), deadLetterJobId(undefined, REC, 1)]) {
      expect(id.startsWith(DLQ_JOB_ID_PREFIX)).toBe(true);
      expect(id).not.toContain(':');
    }
  });

  it('a final permanent failure moves a delayed meeting to failed (and is not dead-lettered)', async () => {
    const { deps, dlq, status } = setup();
    const err = new UnrecoverableError('transcription job failed: provider_failed');
    expect(await handleTranscriptionFailure(job(1), err, deps)).toBe(false);
    expect(status.clearDelayed).toHaveBeenCalledWith(ORG, MEET, 'failed');
    expect(status.markDelayed).not.toHaveBeenCalled();
    expect(dlq.add).not.toHaveBeenCalled();
  });

  it('a retry-exhausted failure parks the meeting in transcription_delayed and does not clear it', async () => {
    const { deps, status } = setup();
    await handleTranscriptionFailure(job(4), outage, deps);
    expect(status.markDelayed).toHaveBeenCalledWith(ORG, MEET);
    expect(status.clearDelayed).not.toHaveBeenCalled();
  });

  const dead = (jobId: string, meetingId = MEET, organizationId = ORG) => ({
    id: `dlq_${jobId}`,
    data: {
      organizationId,
      meetingId,
      recordingId: REC,
      chunkIndex: 0,
      jobId,
      errorCode: 'provider_retryable',
      attemptsMade: 4,
      failedAt: '2026-11-03T12:00:00.000Z',
    },
  });

  it('a success moves a delayed meeting back to processing when none of its chunks is dead-lettered', async () => {
    const { status, logger } = setup();
    // Other meetings' / orgs' entries and the succeeding job's own entry do not count.
    const deadLetters = async () => [
      dead('other', '99999999-9999-4999-8999-999999999999'),
      dead('x', MEET, '88888888-8888-4888-8888-888888888888'),
      dead('job-1'),
    ];
    await handleTranscriptionSuccess(job(1), { status, deadLetters, logger });
    expect(status.clearDelayed).toHaveBeenCalledWith(ORG, MEET, 'processing');
  });

  it('a success does NOT clear transcription_delayed while another chunk of the meeting is dead-lettered', async () => {
    const { status, logger } = setup();
    await handleTranscriptionSuccess(job(1), {
      status,
      deadLetters: async () => [dead('job-2')],
      logger,
    });
    expect(status.clearDelayed).not.toHaveBeenCalled();
  });

  it('a success leaves the meeting delayed when the DLQ cannot be read or no lister is wired', async () => {
    const { status, logger } = setup();
    await handleTranscriptionSuccess(job(1), {
      status,
      deadLetters: async () => {
        throw new Error('redis down');
      },
      logger,
    });
    await handleTranscriptionSuccess(job(1), { status, logger });
    expect(status.clearDelayed).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, meetingId: MEET }),
      'transcription dead-letter lookup failed; meeting left delayed',
    );
  });

  it('a clear-status write error is logged only', async () => {
    const { status, logger } = setup();
    status.clearDelayed.mockRejectedValueOnce(new Error('db down'));
    await expect(
      handleTranscriptionSuccess(job(1), { status, deadLetters: async () => [], logger }),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId: ORG, meetingId: MEET }),
      'transcription delayed-status clear failed',
    );
    await handleTranscriptionSuccess(undefined, { status, deadLetters: async () => [], logger });
    expect(status.clearDelayed).toHaveBeenCalledTimes(1);
  });

  it('meetingHasDeadLetters matches org + meeting and honours exclusions', () => {
    const entries = [dead('a'), dead('b', '99999999-9999-4999-8999-999999999999')];
    expect(meetingHasDeadLetters(entries, ORG, MEET)).toBe(true);
    expect(meetingHasDeadLetters(entries, ORG, MEET, ['a'])).toBe(false);
    expect(meetingHasDeadLetters(entries, '88888888-8888-4888-8888-888888888888', MEET)).toBe(
      false,
    );
  });

  it('uses a dedicated DLQ name', () => {
    expect(TRANSCRIPTION_DLQ).toBe('transcription-dlq');
  });
});
