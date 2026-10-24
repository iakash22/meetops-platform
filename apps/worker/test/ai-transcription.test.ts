import { describe, expect, it } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import {
  AIExecutor, AIError, InMemoryAuditSink, InMemoryIdempotencyStore, InMemoryOrgConfigStore, InMemoryUsageTracker, ModelRouter,
  ProviderRegistry, UsageQuotaManager, aiEnvSchema, createCredentialResolver, roleAbility,
  type ChunkTranscript, type TranscriptRevision, type TranscriptionProvider,
} from '@meetops/ai-core';
import type { TranscriptionJobPayload, TranscriptionProgressEvent } from '@meetops/contracts';
import {
  TranscriptionJobError, createTranscriptionProcessor, processTranscriptionJob, chunkProgressEvent,
  type RecordingScope, type TranscriptRepository, type TranscriptRevisionWrite, type TranscriptionConsumerDeps,
} from '../src/ai/index.js';
import { createRealtimePublisher } from '../src/media/realtime.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '99999999-9999-4999-8999-999999999999';
const MEET = '22222222-2222-4222-8222-222222222222';
const REC = '33333333-3333-4333-8333-333333333333';

const job = (index: number, over: Partial<TranscriptionJobPayload> = {}): TranscriptionJobPayload => ({
  jobVersion: 1, organizationId: ORG, idempotencyKey: `transcribe:${REC}:${index}`, kind: 'transcribe_recording', meetingId: MEET,
  recordingId: REC, fileObjectId: `4444444${index}-4444-4444-8444-444444444444`, chunkIndex: index, startMs: index * 600_000,
  sttProviderId: 'assemblyai', diarize: true, ...over,
});
const jobId = (index: number, org = ORG) => `transcribe_${org}_${REC}_${String(index).padStart(5, '0')}`;

class FakeRepo implements TranscriptRepository {
  recordings = new Map<string, RecordingScope & { recordingId: string }>();
  chunks = new Map<string, ChunkTranscript>();
  revisions: TranscriptRevisionWrite[] = [];
  async findRecording(o: string, r: string) {
    const rec = this.recordings.get(r);
    return rec && rec.organizationId === o ? rec : undefined;
  }
  async putChunkResult(o: string, m: string, r: string, c: ChunkTranscript) {
    const k = `${o}|${m}|${r}|${c.chunkIndex}`;
    if (this.chunks.has(k)) return false;
    this.chunks.set(k, structuredClone(c));
    return true;
  }
  async getChunkResult(o: string, m: string, r: string, i: number) {
    return this.chunks.get(`${o}|${m}|${r}|${i}`);
  }
  async listChunkResults(o: string, m: string, r: string) {
    return [...this.chunks.entries()].filter(([k]) => k.startsWith(`${o}|${m}|${r}|`)).map(([, v]) => v);
  }
  async latestTranscript(o: string, m: string, r: string): Promise<TranscriptRevision | undefined> {
    return this.revisions.filter((w) => w.organizationId === o && w.meetingId === m && w.recordingId === r).at(-1)?.mergeState;
  }
  async writeTranscriptRevision(w: TranscriptRevisionWrite, expectedPrev: number) {
    if (((await this.latestTranscript(w.organizationId, w.meetingId, w.recordingId))?.revision ?? 0) !== expectedPrev) return false;
    this.revisions.push(structuredClone(w));
    return true;
  }
}

async function makeDeps(opts: { fail?: AIError; chunkCount?: number; recordingOrg?: string } = {}) {
  let calls = 0;
  const stt: TranscriptionProvider = {
    providerId: 'assemblyai', kind: 'stt',
    async transcribe() {
      calls++;
      if (opts.fail) throw opts.fail;
      return { text: 'hello world', segments: [{ startSec: 1, endSec: 2.5, text: 'hello world', speaker: 'A', confidence: 0.9 }], durationSec: 600, language: 'en' };
    },
    async getCapabilities() { return { batch: true, streaming: false, diarization: true, languages: ['en'] }; },
    async healthCheck() { return { ok: true, timestamp: 'now' }; },
  };
  const audit = new InMemoryAuditSink();
  const registry = new ProviderRegistry({ assemblyai: () => stt }, createCredentialResolver({ env: () => undefined, secret: async () => undefined }, async () => ({ platformKeys: true })), audit);
  await registry.register({
    name: 'assemblyai', type: 'stt', adapter: 'assemblyai', model: 'universal', enabled: true, capabilities: ['batch-transcription', 'diarization'],
    retryPolicy: { maxAttempts: 1, initialDelayMs: 0, maxDelayMs: 0, backoffMultiplier: 1 }, cost: { tier: 'free' }, platformBilled: false,
  }, { system: true, userId: 'test' });
  const usage = new InMemoryUsageTracker();
  const executor = new AIExecutor({
    registry, router: new ModelRouter(aiEnvSchema.parse({}), new InMemoryOrgConfigStore(), audit), usage, quota: new UsageQuotaManager(usage),
    idempotency: new InMemoryIdempotencyStore(), notify: () => {}, sleep: async () => {},
  });
  const repo = new FakeRepo();
  repo.recordings.set(REC, { recordingId: REC, organizationId: opts.recordingOrg ?? ORG, meetingId: MEET, chunkCount: opts.chunkCount });
  const emitted: Array<{ rooms: string[]; event: string; payload: TranscriptionProgressEvent }> = [];
  const realtime = createRealtimePublisher({ to: (rooms) => ({ emit: (event, payload) => emitted.push({ rooms: [rooms].flat(), event, payload: payload as TranscriptionProgressEvent }) }) });
  const logs: unknown[] = [];
  const log = (obj: object, msg: string) => void logs.push({ obj, msg });
  const deps: TranscriptionConsumerDeps = {
    executor, repository: repo, realtime, geometry: { segmentSeconds: 600 },
    resolveAudio: async () => ({ bytes: new Uint8Array([1, 2, 3]), mimeType: 'audio/wav' }),
    resolveActor: async ({ organizationId }) => ({ organizationId, userId: 'svc', ability: roleAbility('admin') }),
    logger: { info: log, warn: log, error: log }, now: () => new Date('2026-10-24T08:00:00.000Z'),
  };
  return { deps, repo, emitted, logs, calls: () => calls };
}

describe('AI transcription consumer', () => {
  it('success: persists Transcript + segments and publishes org-scoped progress', async () => {
    const { deps, repo, emitted, calls } = await makeDeps({ chunkCount: 2 });
    const r = await processTranscriptionJob(job(1), deps, { jobId: jobId(1) });
    expect(r).toMatchObject({ chunkIndex: 1, duplicate: false, revision: 1, revisionChanged: true });
    expect(calls()).toBe(1);
    expect(repo.revisions).toHaveLength(1);
    const w = repo.revisions[0]!;
    expect(w).toMatchObject({ organizationId: ORG, meetingId: MEET, recordingId: REC, provider: 'assemblyai', revision: 1, status: 'processing', language: 'en' });
    expect(w.segments).toEqual([{ sequence: 0, speakerLabel: 'S1', startMs: 601_000, endMs: 602_500, text: 'hello world', confidence: 0.9 }]);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.event).toBe('transcription:progress');
    expect(emitted[0]!.rooms).toEqual([`org:${ORG}:meeting:${MEET}`, `org:${ORG}`]);
    expect(emitted[0]!.payload).toEqual({ organizationId: ORG, meetingId: MEET, recordingId: REC, percent: 92, stage: 'transcribing', chunksDone: 1, chunksTotal: 2, at: '2026-10-24T08:00:00.000Z' });

    await processTranscriptionJob(job(0), deps, { jobId: jobId(0) });
    expect(repo.revisions.at(-1)).toMatchObject({ revision: 2, status: 'ready' });
    expect(emitted.at(-1)!.payload).toMatchObject({ percent: 100, stage: 'merging', chunksDone: 2, chunksTotal: 2 });
  });

  it('idempotent replay: no second provider call, no new revision', async () => {
    const { deps, repo, calls } = await makeDeps();
    await processTranscriptionJob(job(0), deps, { jobId: jobId(0) });
    const again = await processTranscriptionJob(job(0), deps, { jobId: jobId(0) });
    expect(calls()).toBe(1);
    expect(again).toMatchObject({ duplicate: true, revisionChanged: false, revision: 1 });
    expect(repo.revisions).toHaveLength(1);
  });

  it('rejects an idempotency key that is not transcribe:{recordingId}:{index} (permanent)', async () => {
    const { deps, calls } = await makeDeps();
    const p = createTranscriptionProcessor(deps);
    await expect(p({ id: jobId(0), name: 'transcription', data: job(0, { idempotencyKey: `transcribe:${REC}:7` }) })).rejects.toBeInstanceOf(UnrecoverableError);
    expect(calls()).toBe(0);
  });

  it('provider failure: retryable stays retryable, permanent becomes UnrecoverableError; nothing persisted; no secrets logged', async () => {
    const retry = await makeDeps({ fail: new AIError('PROVIDER_UNAVAILABLE', 'upstream 503 key=sk-SECRET', { provider: 'assemblyai', retryable: true }) });
    const p1 = createTranscriptionProcessor(retry.deps);
    const e1 = await p1({ id: jobId(0), name: 'transcription', data: job(0) }).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(TranscriptionJobError);
    expect(e1).not.toBeInstanceOf(UnrecoverableError);
    expect((e1 as TranscriptionJobError).retryable).toBe(true);
    expect(retry.repo.revisions).toHaveLength(0);
    expect(retry.emitted).toHaveLength(0);
    expect(JSON.stringify(retry.logs)).not.toContain('SECRET');

    const perm = await makeDeps({ fail: new AIError('INVALID_OUTPUT', 'bad audio', { provider: 'assemblyai', retryable: false }) });
    const e2 = await createTranscriptionProcessor(perm.deps)({ id: jobId(0), name: 'transcription', data: job(0) }).catch((e: unknown) => e);
    expect(e2).toBeInstanceOf(UnrecoverableError);
    expect(perm.repo.revisions).toHaveLength(0);
  });

  it('org mismatch: recording owned by another org is a permanent failure with no provider call or writes', async () => {
    const { deps, repo, emitted, calls } = await makeDeps({ recordingOrg: OTHER });
    const e = await processTranscriptionJob(job(0), deps, { jobId: jobId(0) }).catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'recording_not_found', retryable: false });
    // Recording visible to the org but attached to a different meeting -> org_mismatch.
    repo.recordings.set(REC, { recordingId: REC, organizationId: ORG, meetingId: '55555555-5555-4555-8555-555555555555' });
    await expect(processTranscriptionJob(job(0), deps, { jobId: jobId(0) })).rejects.toMatchObject({ code: 'org_mismatch', retryable: false });
    // BullMQ job id scoped to another org is rejected too.
    await expect(processTranscriptionJob(job(0), deps, { jobId: jobId(0, OTHER) })).rejects.toMatchObject({ code: 'invalid_payload' });
    expect(calls()).toBe(0);
    expect(repo.revisions).toHaveLength(0);
    expect(emitted).toHaveLength(0);
  });

  it('progress without known chunk total stays at 85 and omits chunksTotal', () => {
    const e = chunkProgressEvent({ organizationId: ORG, meetingId: MEET, recordingId: REC, chunksDone: 3, complete: false, at: new Date(0) });
    expect(e).toEqual({ organizationId: ORG, meetingId: MEET, recordingId: REC, percent: 85, stage: 'transcribing', chunksDone: 3, at: '1970-01-01T00:00:00.000Z' });
  });
});
