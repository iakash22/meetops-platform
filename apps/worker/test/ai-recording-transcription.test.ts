import { describe, expect, it } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import type { ChunkTranscript, TranscriptRevision } from '@meetops/ai-core';
import type { DatabaseTransaction } from '@meetops/database';
import {
  ProviderError,
  RecordingTranscriptionError,
  createRecordingTranscriptionProcessor,
  processRecordingTranscription,
  type OrgScopedRecordingTranscriptRepository,
  type RecordingTranscriptRepository,
  type RecordingTranscriptionDeps,
  type TranscribeResult,
  type TranscriptRevisionWrite,
  type TranscriptionProvider,
} from '../src/ai/index.js';
import { createOrgScopedTranscriptRepository } from '../src/ai/prisma-repository.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';
const MEET = '22222222-2222-4222-8222-222222222222';
const REC = '33333333-3333-4333-8333-333333333333';
const input = { organizationId: ORG, meetingId: MEET, recordingId: REC };

class FakeRepo implements RecordingTranscriptRepository {
  meetingOrg = ORG;
  chunks: ChunkTranscript[] = [];
  revisions: TranscriptRevisionWrite[] = [];
  failed: string[] = [];
  contexts: string[] = [];
  failWritesOnce = false;
  conflictAlways = false;
  async withOrgContext<T>(
    o: string,
    fn: (r: OrgScopedRecordingTranscriptRepository) => Promise<T>,
  ): Promise<T> {
    this.contexts.push(o);
    const latest = async (): Promise<TranscriptRevision | undefined> =>
      this.revisions.at(-1)?.mergeState;
    return fn({
      findMeeting: async (id) =>
        id === MEET && this.meetingOrg === o ? { id, organizationId: o } : undefined,
      findRecording: async (id) =>
        id === REC ? { id, organizationId: o, meetingId: MEET, chunkCount: 1 } : undefined,
      putChunkResult: async (_m, _r, c) => {
        if (this.chunks.some((x) => x.chunkIndex === c.chunkIndex)) return false;
        this.chunks.push(structuredClone(c));
        return true;
      },
      getChunkResult: async (_m, _r, i) => this.chunks.find((c) => c.chunkIndex === i),
      listChunkResults: async () => this.chunks,
      latestTranscript: latest,
      writeTranscriptRevision: async (w, prev) => {
        if (this.failWritesOnce) {
          this.failWritesOnce = false;
          throw new Error('db down');
        }
        if (this.conflictAlways || ((await latest())?.revision ?? 0) !== prev) return false;
        this.revisions.push(structuredClone(w));
        return true;
      },
      markTranscriptFailed: async (_m, r, p) => void this.failed.push(`${r}:${p}`),
    });
  }
}

const RESULT: TranscribeResult = {
  provider: 'assemblyai',
  model: 'universal',
  providerJobId: 'tr_1',
  language: 'en',
  durationMs: 5000,
  text: 'Hello. Yes.',
  segments: [
    { speaker: 'A', startMs: 0, endMs: 1500, text: 'Hello.', confidence: 0.9 },
    { speaker: 'B', startMs: 1600, endMs: 2500, text: 'Yes.', confidence: null },
  ],
};

function setup(behaviour: Array<TranscribeResult | ProviderError | Error> = [RESULT]) {
  const repo = new FakeRepo();
  const logs: Array<{ obj: object; msg: string }> = [];
  const log = (obj: object, msg: string) => void logs.push({ obj, msg });
  let calls = 0;
  const provider: TranscriptionProvider = {
    id: 'assemblyai',
    async transcribe() {
      const next = behaviour[Math.min(calls++, behaviour.length - 1)]!;
      if (next instanceof Error) throw next;
      return next;
    },
    async fetchResult() {
      return { status: 'pending' };
    },
  };
  const deps: RecordingTranscriptionDeps = {
    provider,
    repository: repo,
    logger: { info: log, warn: log, error: log },
    resolveAudio: async () => ({
      kind: 'url',
      url: 'https://storage.example/rec.webm?X-Amz-Signature=SECRET',
    }),
    now: () => new Date('2026-10-27T06:00:00.000Z'),
  };
  return { repo, deps, logs, calls: () => calls };
}

describe('recording transcription job', () => {
  it('stores the transcript (revision 1, ready, speaker-normalized segments) in the org context', async () => {
    const { repo, deps, calls } = setup();
    const r = await processRecordingTranscription(input, deps, { jobId: 'j1' });
    expect(r).toEqual({ recordingId: REC, revision: 1, duplicate: false, providerCalled: true });
    expect(calls()).toBe(1);
    expect(new Set(repo.contexts)).toEqual(new Set([ORG]));
    expect(repo.chunks).toHaveLength(1);
    const w = repo.revisions[0]!;
    expect(w).toMatchObject({
      organizationId: ORG,
      provider: 'assemblyai',
      revision: 1,
      status: 'ready',
      language: 'en',
      fullText: 'S1: Hello.\nS2: Yes.',
    });
    expect(w.segments).toEqual([
      { sequence: 0, speakerLabel: 'S1', startMs: 0, endMs: 1500, text: 'Hello.', confidence: 0.9 },
      {
        sequence: 1,
        speakerLabel: 'S2',
        startMs: 1600,
        endMs: 2500,
        text: 'Yes.',
        confidence: null,
      },
    ]);
  });

  it('is idempotent: a replay calls no provider and writes no revision', async () => {
    const { repo, deps, calls } = setup();
    await processRecordingTranscription(input, deps);
    const again = await processRecordingTranscription(input, deps);
    expect(again).toEqual({
      recordingId: REC,
      revision: 1,
      duplicate: true,
      providerCalled: false,
    });
    expect(calls()).toBe(1);
    expect(repo.revisions).toHaveLength(1);
  });

  it('is retry-safe: a DB failure after the provider call reuses the stored provider result', async () => {
    const { repo, deps, calls } = setup();
    repo.failWritesOnce = true;
    await expect(processRecordingTranscription(input, deps)).rejects.toThrow('db down');
    expect(repo.chunks).toHaveLength(1);
    const r = await processRecordingTranscription(input, deps);
    expect(r).toMatchObject({ revision: 1, providerCalled: false });
    expect(calls()).toBe(1);
  });

  it('a permanent provider error records failed status and is unrecoverable', async () => {
    const { repo, deps } = setup([new ProviderError('assemblyai', 'auth', 401)]);
    const proc = createRecordingTranscriptionProcessor(deps);
    await expect(
      proc({ id: 'j', data: input, attemptsMade: 0, opts: { attempts: 5 } }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(repo.failed).toEqual([`${REC}:assemblyai`]);
    expect(repo.revisions).toHaveLength(0);
  });

  it('a retryable error marks failed only on the final attempt, then a retry can succeed', async () => {
    const { repo, deps } = setup([new ProviderError('assemblyai', 'rate_limited', 429), RESULT]);
    const proc = createRecordingTranscriptionProcessor(deps);
    const err = await proc({ data: input, attemptsMade: 0, opts: { attempts: 3 } }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RecordingTranscriptionError);
    expect(err).toMatchObject({ code: 'provider_rate_limited', retryable: true });
    expect(repo.failed).toHaveLength(0);
    await expect(
      proc({ data: input, attemptsMade: 1, opts: { attempts: 3 } }),
    ).resolves.toMatchObject({ revision: 1 });

    const last = setup([new ProviderError('assemblyai', 'unavailable', 503)]);
    await expect(
      createRecordingTranscriptionProcessor(last.deps)({
        data: input,
        attemptsMade: 2,
        opts: { attempts: 3 },
      }),
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(last.repo.failed).toHaveLength(1);
  });

  it('unknown provider errors are retryable; audio resolution failures are retryable and call no provider', async () => {
    const a = setup([new Error('boom')]);
    await expect(processRecordingTranscription(input, a.deps)).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
    });
    const b = setup();
    b.deps.resolveAudio = async () => {
      throw new Error('no object');
    };
    await expect(processRecordingTranscription(input, b.deps)).rejects.toMatchObject({
      code: 'audio_unavailable',
      retryable: true,
    });
    expect(b.calls()).toBe(0);
  });

  it('tenant checks: foreign meeting, unknown recording, invalid payload', async () => {
    const { repo, deps, calls } = setup();
    repo.meetingOrg = OTHER;
    await expect(processRecordingTranscription(input, deps)).rejects.toMatchObject({
      code: 'meeting_not_found',
      retryable: false,
    });
    repo.meetingOrg = ORG;
    await expect(
      processRecordingTranscription({ ...input, recordingId: OTHER }, deps),
    ).rejects.toMatchObject({ code: 'recording_not_found' });
    await expect(
      processRecordingTranscription({ ...input, organizationId: 'x' }, deps),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
    await expect(
      processRecordingTranscription({ ...input, extra: 1 } as never, deps),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
    expect(calls()).toBe(0);
  });

  it('persistent revision conflicts are retryable', async () => {
    const { repo, deps } = setup();
    repo.conflictAlways = true;
    await expect(processRecordingTranscription(input, deps)).rejects.toMatchObject({
      code: 'revision_conflict',
      retryable: true,
    });
  });

  it('never logs the audio URL or transcript text', async () => {
    const { deps, logs } = setup([new ProviderError('assemblyai', 'auth', 401)]);
    await processRecordingTranscription(input, deps).catch(() => undefined);
    const ok = setup();
    await processRecordingTranscription(input, ok.deps);
    const all = JSON.stringify([...logs, ...ok.logs]);
    expect(all).not.toContain('SECRET');
    expect(all).not.toContain('Hello.');
  });

  it('prisma markTranscriptFailed updates only this org anchor', async () => {
    const calls: unknown[] = [];
    const tx = {
      transcript: {
        findFirst: async () => ({ id: 'anchor' }),
        updateMany: async (args: unknown) => (calls.push(args), { count: 1 }),
      },
    } as unknown as DatabaseTransaction;
    await createOrgScopedTranscriptRepository(tx, ORG).markTranscriptFailed(
      MEET,
      REC,
      'assemblyai',
    );
    expect(calls).toEqual([
      { where: { organizationId: ORG, id: 'anchor', revision: 0 }, data: { status: 'failed' } },
    ]);
  });
});
