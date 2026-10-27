import { describe, expect, it } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import {
  AIExecutor,
  AIError,
  InMemoryAuditSink,
  InMemoryIdempotencyStore,
  InMemoryOrgConfigStore,
  InMemoryUsageTracker,
  ModelRouter,
  ProviderRegistry,
  UsageQuotaManager,
  aiEnvSchema,
  createCredentialResolver,
  type ChunkTranscript,
  type TranscriptionProvider,
} from '@meetops/ai-core';
import type { TranscriptionJobPayload, TranscriptionProgressEvent } from '@meetops/contracts';
import {
  TRANSCRIPTION_SYSTEM_ACTOR,
  TranscriptionJobError,
  TranscriptionWorkerEnvError,
  createTranscriptionProcessor,
  loadTranscriptionWorkerEnv,
  processTranscriptionJob,
  chunkProgressEvent,
  registerTranscriptionWorker,
  type MeetingScope,
  type OrgScopedTranscriptRepository,
  type RecordingScope,
  type TranscriptRepository,
  type TranscriptRevisionWrite,
  type TranscriptionAuditEntry,
  type TranscriptionConsumerDeps,
  type TranscriptionHostDeps,
} from '../src/ai/index.js';
import { createRealtimePublisher } from '../src/media/realtime.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';
const MEET = '22222222-2222-4222-8222-222222222222';
const REC = '33333333-3333-4333-8333-333333333333';

const job = (
  index: number,
  over: Partial<TranscriptionJobPayload> = {},
): TranscriptionJobPayload => ({
  jobVersion: 1,
  organizationId: ORG,
  idempotencyKey: `transcribe:${REC}:${index}`,
  kind: 'transcribe_recording',
  meetingId: MEET,
  recordingId: REC,
  fileObjectId: `4444444${index}-4444-4444-8444-444444444444`,
  chunkIndex: index,
  startMs: index * 600_000,
  sttProviderId: 'assemblyai',
  diarize: true,
  ...over,
});
const jobId = (index: number, org = ORG) =>
  `transcribe_${org}_${REC}_${String(index).padStart(5, '0')}`;

type Row<T> = T & { organizationId: string };
/** Fake that mimics forced RLS: rows from other orgs are invisible inside withOrgContext. */
class FakeRepo implements TranscriptRepository {
  meetings = new Map<string, MeetingScope>();
  recordings = new Map<string, RecordingScope>();
  chunks: Array<Row<{ meetingId: string; recordingId: string; chunk: ChunkTranscript }>> = [];
  revisions: TranscriptRevisionWrite[] = [];
  contexts: string[] = [];
  async withOrgContext<T>(
    o: string,
    fn: (r: OrgScopedTranscriptRepository) => Promise<T>,
  ): Promise<T> {
    this.contexts.push(o);
    const latest = async (m: string, r: string) =>
      this.revisions
        .filter((w) => w.organizationId === o && w.meetingId === m && w.recordingId === r)
        .at(-1)?.mergeState;
    const list = (m: string, r: string) =>
      this.chunks.filter((c) => c.organizationId === o && c.meetingId === m && c.recordingId === r);
    return fn({
      findMeeting: async (id) =>
        [...this.meetings.values()].find(
          (x) => x.id === id && (this.rlsOff || x.organizationId === o),
        ),
      findRecording: async (id) =>
        [...this.recordings.values()].find((x) => x.id === id && x.organizationId === o),
      putChunkResult: async (m, r, chunk) => {
        if (list(m, r).some((c) => c.chunk.chunkIndex === chunk.chunkIndex)) return false;
        this.chunks.push({
          organizationId: o,
          meetingId: m,
          recordingId: r,
          chunk: structuredClone(chunk),
        });
        return true;
      },
      getChunkResult: async (m, r, i) => list(m, r).find((c) => c.chunk.chunkIndex === i)?.chunk,
      listChunkResults: async (m, r) => list(m, r).map((c) => c.chunk),
      latestTranscript: latest,
      writeTranscriptRevision: async (w, prev) => {
        if (w.organizationId !== o) throw new Error('cross-org write');
        if (((await latest(w.meetingId, w.recordingId))?.revision ?? 0) !== prev) return false;
        this.revisions.push(structuredClone(w));
        return true;
      },
    });
  }
  /** Simulates a misconfigured (non-RLS) implementation to prove the explicit organizationId assertion. */
  rlsOff = false;
}

async function makeDeps(opts: { fail?: AIError; chunkCount?: number; meetingOrg?: string } = {}) {
  let calls = 0;
  const stt: TranscriptionProvider = {
    providerId: 'assemblyai',
    kind: 'stt',
    async transcribe() {
      calls++;
      if (opts.fail) throw opts.fail;
      return {
        text: 'hello world',
        segments: [
          { startSec: 1, endSec: 2.5, text: 'hello world', speaker: 'A', confidence: 0.9 },
        ],
        durationSec: 600,
        language: 'en',
      };
    },
    async getCapabilities() {
      return { batch: true, streaming: false, diarization: true, languages: ['en'] };
    },
    async healthCheck() {
      return { ok: true, timestamp: 'now' };
    },
  };
  const audit = new InMemoryAuditSink();
  const registry = new ProviderRegistry(
    { assemblyai: () => stt },
    createCredentialResolver({ env: () => undefined, secret: async () => undefined }, async () => ({
      platformKeys: true,
    })),
    audit,
  );
  await registry.register(
    {
      name: 'assemblyai',
      type: 'stt',
      adapter: 'assemblyai',
      model: 'universal',
      enabled: true,
      capabilities: ['batch-transcription', 'diarization'],
      retryPolicy: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, backoffMultiplier: 1 },
      cost: { tier: 'free' },
      platformBilled: false,
    },
    { system: true, userId: 'test' },
  );
  const usage = new InMemoryUsageTracker();
  const executor = new AIExecutor({
    registry,
    router: new ModelRouter(aiEnvSchema.parse({}), new InMemoryOrgConfigStore(), audit),
    usage,
    quota: new UsageQuotaManager(usage),
    idempotency: new InMemoryIdempotencyStore(),
    notify: () => {},
    sleep: async () => {},
  });
  const repo = new FakeRepo();
  repo.meetings.set(MEET, { id: MEET, organizationId: opts.meetingOrg ?? ORG });
  repo.recordings.set(REC, {
    id: REC,
    organizationId: opts.meetingOrg ?? ORG,
    meetingId: MEET,
    chunkCount: opts.chunkCount,
  });
  const audits: TranscriptionAuditEntry[] = [];
  const emitted: Array<{ rooms: string[]; event: string; payload: TranscriptionProgressEvent }> =
    [];
  const realtime = createRealtimePublisher({
    to: (rooms) => ({
      emit: (event, payload) =>
        emitted.push({
          rooms: [rooms].flat(),
          event,
          payload: payload as TranscriptionProgressEvent,
        }),
    }),
  });
  const logs: unknown[] = [];
  const log = (obj: object, msg: string) => void logs.push({ obj, msg });
  const deps: TranscriptionConsumerDeps = {
    executor,
    repository: repo,
    realtime,
    geometry: { segmentSeconds: 600 },
    resolveAudio: async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' }),
    audit: { record: (e) => void audits.push(e) },
    logger: { info: log, warn: log, error: log },
    now: () => new Date('2026-10-24T08:00:00.000Z'),
  };
  return { deps, repo, emitted, logs, audits, calls: () => calls };
}

describe('AI transcription consumer', () => {
  it('success: persists Transcript + segments and publishes org-scoped progress', async () => {
    const { deps, repo, emitted, calls } = await makeDeps({ chunkCount: 2 });
    const r = await processTranscriptionJob(job(1), deps, { jobId: jobId(1) });
    expect(r).toMatchObject({
      chunkIndex: 1,
      duplicate: false,
      revision: 1,
      revisionChanged: true,
    });
    expect(calls()).toBe(1);
    expect(repo.revisions).toHaveLength(1);
    expect(new Set(repo.contexts)).toEqual(new Set([ORG]));
    const w = repo.revisions[0]!;
    expect(w).toMatchObject({
      organizationId: ORG,
      meetingId: MEET,
      recordingId: REC,
      provider: 'assemblyai',
      revision: 1,
      status: 'processing',
      language: 'en',
    });
    expect(w.segments).toEqual([
      {
        sequence: 0,
        speakerLabel: 'S1',
        startMs: 601_000,
        endMs: 602_500,
        text: 'hello world',
        confidence: 0.9,
      },
    ]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.event).toBe('transcription:progress');
    expect(emitted[0]!.rooms).toEqual([
      `organizations:${ORG}:meetings:${MEET}`,
      `organizations:${ORG}`,
    ]);
    expect(emitted[0]!.payload).toEqual({
      organizationId: ORG,
      meetingId: MEET,
      recordingId: REC,
      percent: 92,
      stage: 'transcribing',
      chunksDone: 1,
      chunksTotal: 2,
      at: '2026-10-24T08:00:00.000Z',
    });

    await processTranscriptionJob(job(0), deps, { jobId: jobId(0) });
    expect(repo.revisions.at(-1)).toMatchObject({ revision: 2, status: 'ready' });
    expect(emitted.at(-1)!.payload).toMatchObject({
      percent: 100,
      stage: 'merging',
      chunksDone: 2,
      chunksTotal: 2,
    });
  });

  it('idempotent replay: no second provider call, no new revision', async () => {
    const { deps, repo, audits, calls } = await makeDeps();
    await processTranscriptionJob(job(0), deps, { jobId: jobId(0) });
    const again = await processTranscriptionJob(job(0), deps, { jobId: jobId(0) });
    expect(calls()).toBe(1);
    expect(again).toMatchObject({ duplicate: true, revisionChanged: false, revision: 1 });
    expect(audits.map((a) => a.outcome)).toEqual(['succeeded', 'duplicate']);
    expect(audits[0]).toMatchObject({
      actor: { type: 'system', id: 'worker:transcription' },
      organizationId: ORG,
      provider: 'assemblyai',
      revision: 1,
    });
    expect(repo.revisions).toHaveLength(1);
  });

  it('rejects an idempotency key that is not transcribe:{recordingId}:{index} (permanent)', async () => {
    const { deps, calls } = await makeDeps();
    const p = createTranscriptionProcessor(deps);
    await expect(
      p({
        id: jobId(0),
        name: 'transcription',
        data: job(0, { idempotencyKey: `transcribe:${REC}:7` }),
      }),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(calls()).toBe(0);
  });

  it('provider failure: retryable stays retryable, permanent becomes UnrecoverableError; nothing persisted; no secrets logged', async () => {
    const retry = await makeDeps({
      fail: new AIError('PROVIDER_UNAVAILABLE', 'upstream 503 key=sk-SECRET', {
        provider: 'assemblyai',
        retryable: true,
      }),
    });
    const p1 = createTranscriptionProcessor(retry.deps);
    const e1 = await p1({ id: jobId(0), name: 'transcription', data: job(0) }).catch(
      (e: unknown) => e,
    );
    expect(e1).toBeInstanceOf(TranscriptionJobError);
    expect(e1).not.toBeInstanceOf(UnrecoverableError);
    expect((e1 as TranscriptionJobError).retryable).toBe(true);
    expect(retry.repo.revisions).toHaveLength(0);
    expect(retry.emitted).toHaveLength(0);
    expect(JSON.stringify(retry.logs)).not.toContain('SECRET');

    const perm = await makeDeps({
      fail: new AIError('INVALID_OUTPUT', 'bad audio', {
        provider: 'assemblyai',
        retryable: false,
      }),
    });
    const e2 = await createTranscriptionProcessor(perm.deps)({
      id: jobId(0),
      name: 'transcription',
      data: job(0),
    }).catch((e: unknown) => e);
    expect(e2).toBeInstanceOf(UnrecoverableError);
    expect(perm.repo.revisions).toHaveLength(0);
  });

  it('org mismatch: meeting checked first; foreign meeting rejected permanently with no provider call or writes', async () => {
    const { deps, repo, emitted, audits, calls } = await makeDeps({ meetingOrg: OTHER });
    // RLS hides the foreign meeting.
    await expect(processTranscriptionJob(job(0), deps, { jobId: jobId(0) })).rejects.toMatchObject({
      code: 'meeting_not_found',
      retryable: false,
    });
    // Even if an implementation leaks it, the explicit meeting.organizationId === job.organizationId assertion rejects it.
    repo.rlsOff = true;
    await expect(processTranscriptionJob(job(0), deps, { jobId: jobId(0) })).rejects.toMatchObject({
      code: 'org_mismatch',
      retryable: false,
    });
    expect(calls()).toBe(0);
    expect(repo.revisions).toHaveLength(0);
    expect(emitted).toHaveLength(0);
    expect(new Set(repo.contexts)).toEqual(new Set([ORG]));
    expect(audits.map((a) => [a.outcome, a.errorCode, a.organizationId, a.actor.id])).toEqual([
      ['rejected', 'meeting_not_found', ORG, 'worker:transcription'],
      ['rejected', 'org_mismatch', ORG, 'worker:transcription'],
    ]);
  });

  it('recording on another meeting and job id for another org are rejected', async () => {
    const { deps, repo, calls } = await makeDeps();
    await expect(
      processTranscriptionJob(job(0), deps, { jobId: jobId(0, OTHER) }),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
    repo.recordings.set(REC, {
      id: REC,
      organizationId: ORG,
      meetingId: '55555555-5555-4555-8555-555555555555',
    });
    await expect(processTranscriptionJob(job(0), deps, { jobId: jobId(0) })).rejects.toMatchObject({
      code: 'org_mismatch',
    });
    expect(calls()).toBe(0);
  });

  it('progress without known chunk total stays at 85 and omits chunksTotal', () => {
    const e = chunkProgressEvent({
      organizationId: ORG,
      meetingId: MEET,
      recordingId: REC,
      chunksDone: 3,
      complete: false,
      at: new Date(0),
    });
    expect(e).toEqual({
      organizationId: ORG,
      meetingId: MEET,
      recordingId: REC,
      percent: 85,
      stage: 'transcribing',
      chunksDone: 3,
      at: '1970-01-01T00:00:00.000Z',
    });
  });
});

describe('transcription worker env + registration', () => {
  const noopLog = { info: () => {}, warn: () => {} };
  it('TRANSCRIPTION_WORKER_ENABLED defaults to false and is validated', () => {
    expect(loadTranscriptionWorkerEnv({})).toEqual({
      enabled: false,
      concurrency: 1,
      segmentSeconds: 600,
      redisUrl: 'redis://localhost:6379',
    });
    expect(loadTranscriptionWorkerEnv({ TRANSCRIPTION_WORKER_ENABLED: 'TRUE' }).enabled).toBe(true);
    expect(() => loadTranscriptionWorkerEnv({ TRANSCRIPTION_WORKER_ENABLED: 'maybe' })).toThrow(
      TranscriptionWorkerEnvError,
    );
    expect(() => loadTranscriptionWorkerEnv({ TRANSCRIPTION_WORKER_CONCURRENCY: '0' })).toThrow(
      TranscriptionWorkerEnvError,
    );
  });
  it('off: processor not registered even with deps', () => {
    let started = 0;
    const r = registerTranscriptionWorker({
      env: loadTranscriptionWorkerEnv({}),
      logger: noopLog,
      resolveDeps: () => ({}) as TranscriptionHostDeps,
      start: () => {
        started++;
        return { worker: {} as never, close: async () => {} };
      },
    });
    expect(r).toEqual({ registered: false, reason: 'disabled' });
    expect(started).toBe(0);
  });
  it('on without an injectable repository: not registered', () => {
    const r = registerTranscriptionWorker({
      env: loadTranscriptionWorkerEnv({ TRANSCRIPTION_WORKER_ENABLED: 'true' }),
      logger: noopLog,
    });
    expect(r).toEqual({ registered: false, reason: 'missing_dependencies' });
  });
  it('on with deps: registers with env config and geometry', async () => {
    const { deps } = await makeDeps();
    const calls: unknown[] = [];
    const r = registerTranscriptionWorker({
      env: loadTranscriptionWorkerEnv({
        TRANSCRIPTION_WORKER_ENABLED: '1',
        TRANSCRIPTION_WORKER_CONCURRENCY: '3',
        MEDIA_CHUNK_SECONDS: '300',
      }),
      logger: noopLog,
      resolveDeps: () => ({
        executor: deps.executor,
        repository: deps.repository,
        resolveAudio: deps.resolveAudio,
        audit: deps.audit,
      }),
      start: (cfg: unknown, d: { geometry: unknown }) => {
        calls.push([cfg, d.geometry]);
        return { worker: {} as never, close: async () => {} };
      },
    });
    expect(r.registered).toBe(true);
    expect(calls).toEqual([
      [{ redisUrl: 'redis://localhost:6379', concurrency: 3 }, { segmentSeconds: 300 }],
    ]);
  });
  it('system actor identity', () => {
    expect(TRANSCRIPTION_SYSTEM_ACTOR).toEqual({ type: 'system', id: 'worker:transcription' });
  });
});

describe('chunk consumer -> summary trigger', () => {
  it('enqueues only when the merged transcript becomes ready', async () => {
    const { deps } = await makeDeps({ chunkCount: 2 });
    const events: unknown[] = [];
    deps.summaryTrigger = { transcriptReady: async (e) => void events.push(e) };
    await processTranscriptionJob(job(1), deps, { jobId: jobId(1) });
    expect(events).toEqual([]);
    await processTranscriptionJob(job(0), deps, { jobId: jobId(0) });
    expect(events).toEqual([{ organizationId: ORG, meetingId: MEET, transcriptRevision: 2 }]);
  });
  it('enqueue failure is retryable, not permanent', async () => {
    const { deps } = await makeDeps({ chunkCount: 1 });
    deps.summaryTrigger = {
      transcriptReady: async () => {
        throw new Error('redis down');
      },
    };
    await expect(processTranscriptionJob(job(0), deps, { jobId: jobId(0) })).rejects.toMatchObject({
      code: 'summary_enqueue_failed',
      retryable: true,
    });
  });
});
