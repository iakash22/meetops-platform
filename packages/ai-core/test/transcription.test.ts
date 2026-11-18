import { describe, it, expect } from 'vitest';
import {
  mergeChunkTranscripts,
  InMemoryTranscriptStore,
  TranscriptionChunkHandler,
  chunkIdempotencyKey,
  type ChunkTranscript,
  type TranscriptionChunkJobPayload,
  type TranscriptionProvider,
} from '../src/index.js';
import { admin, setup } from './helpers.js';

const ch = (
  i: number,
  segs: Array<[number, number, string, string?]>,
  o: Partial<ChunkTranscript> = {},
): ChunkTranscript => ({
  chunkIndex: i,
  startSec: i * 60 - (i ? 5 : 0),
  durationSec: 65,
  overlapSec: i ? 5 : 0,
  provider: 'p',
  model: 'm',
  receivedAt: `2026-01-01T00:00:0${i}Z`,
  segments: segs.map(([s, e, text, speaker]) => ({ startSec: s, endSec: e, text, speaker })),
  ...o,
});

describe('mergeChunkTranscripts', () => {
  const c0 = ch(0, [
    [0, 10, 'hello', 'A'],
    [50, 58, 'overlap one', 'B'],
    [56, 59.5, 'tail', 'B'],
  ]);
  // chunk1 starts at 55; first 5s overlap with chunk0
  const c1 = ch(1, [
    [1, 4, 'tail', 'A'],
    [5, 20, 'next part', 'A'],
    [20, 30, 'other', 'B'],
  ]);
  it('applies offsets, trims overlap, orders segments', () => {
    const m = mergeChunkTranscripts([c1, c0]);
    expect(m.segments.map((s) => [s.text, s.startSec])).toEqual([
      ['hello', 0],
      ['overlap one', 50],
      ['tail', 56],
      ['next part', 60],
      ['other', 75],
    ]);
    expect(m.complete).toBe(true);
    expect(m.durationSec).toBe(120);
  });
  it('normalizes speakers across chunks via overlap', () => {
    const m = mergeChunkTranscripts([c0, c1]);
    // chunk1 "A" spoke during chunk0 "B"'s overlap speech -> same person
    expect(m.speakerMap[0]).toEqual({ A: 'S1', B: 'S2' });
    expect(m.speakerMap[1]?.A).toBe('S2');
    expect(m.speakerMap[1]?.B).toBe('S3');
  });
  it('dedupes duplicate chunks (first received wins) and reports gaps', () => {
    const dup = {
      ...c0,
      receivedAt: '2026-01-02T00:00:00Z',
      segments: [{ startSec: 0, endSec: 1, text: 'LATE DUP' }],
    };
    const c2 = ch(2, [[6, 8, 'after gap', 'A']]);
    const m = mergeChunkTranscripts([dup, c0, c2], 3);
    expect(m.segments.some((s) => s.text === 'LATE DUP')).toBe(false);
    expect(m.missingChunks).toEqual([1]);
    expect(m.complete).toBe(false);
  });
  it('stable segment ids', () => {
    expect(mergeChunkTranscripts([c0]).segments[0]?.id).toBe('c0-s0');
  });
});

describe('TranscriptionChunkHandler', () => {
  const payload = (index: number, count = 2): TranscriptionChunkJobPayload => ({
    jobVersion: 1,
    organizationId: '00000000-0000-4000-8000-0000000000c1',
    idempotencyKey: `50000000-0000-4000-8000-00000000000${index}`,
    kind: 'transcribe_recording',
    meetingId: '10000000-0000-4000-8000-000000000001',
    recordingId: '30000000-0000-4000-8000-000000000001',
    fileObjectId: '40000000-0000-4000-8000-000000000001',
    sttProviderId: 'assemblyai',
    diarize: true,
    chunk: {
      index,
      count,
      startSec: index * 60 - (index ? 5 : 0),
      durationSec: 65,
      overlapSec: 5,
      fileObjectId: `60000000-0000-4000-8000-00000000000${index}`,
    },
  });
  const mk = async () => {
    let calls = 0;
    const stt: TranscriptionProvider = {
      providerId: 'assemblyai',
      kind: 'stt',
      async transcribe(i) {
        calls++;
        const tag = new TextDecoder().decode(i.bytes);
        return {
          text: `chunk ${tag}`,
          segments: [{ startSec: 10, endSec: 20, text: `words from ${tag}`, speaker: 'A' }],
          durationSec: 65,
        };
      },
      async getCapabilities() {
        return { batch: true, streaming: false, diarization: true, languages: ['en'] };
      },
      async healthCheck() {
        return { ok: true, timestamp: 'x' };
      },
    };
    const s = await setup({
      providers: { assemblyai: stt },
      configs: [
        {
          name: 'assemblyai',
          type: 'stt',
          adapter: 'assemblyai',
          model: 'universal',
          enabled: true,
          capabilities: ['batch-transcription', 'diarization'],
          cost: { tier: 'free' },
          platformBilled: false,
        },
      ],
    });
    const store = new InMemoryTranscriptStore();
    const h = new TranscriptionChunkHandler({
      executor: s.executor,
      store,
      resolveAudio: async ({ fileObjectId }) => ({ bytes: new TextEncoder().encode(fileObjectId) }),
      resolveActor: async ({ organizationId }) => admin(organizationId),
    });
    return { h, store, calls: () => calls, usage: s.usage };
  };
  it('out-of-order chunks -> revisions increment, final complete', async () => {
    const { h, store } = await mk();
    const r1 = await h.handle(payload(1));
    const r0 = await h.handle(payload(0));
    expect(r1.status === 'succeeded' && r1.revision?.revision).toBe(1);
    expect(r1.status === 'succeeded' && r1.revision?.complete).toBe(false);
    expect(r0.status === 'succeeded' && r0.revision?.revision).toBe(2);
    expect(r0.status === 'succeeded' && r0.revision?.complete).toBe(true);
    expect(
      store
        .revisions(
          '00000000-0000-4000-8000-0000000000c1',
          '10000000-0000-4000-8000-000000000001',
          '30000000-0000-4000-8000-000000000001',
        )
        .map((r) => r.revision),
    ).toEqual([1, 2]);
  });
  it('duplicate chunk: no second STT call, no new revision', async () => {
    const { h, store, calls, usage } = await mk();
    await h.handle(payload(0));
    const again = await h.handle(payload(0));
    expect(calls()).toBe(1);
    expect(again).toMatchObject({ status: 'succeeded', duplicate: true, revisionChanged: false });
    expect(
      store.revisions(
        '00000000-0000-4000-8000-0000000000c1',
        '10000000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000001',
      ),
    ).toHaveLength(1);
    expect(usage.records[0]?.usage.audioSeconds).toBe(65);
  });
  it('tenant-scoped storage and idempotency key', async () => {
    const { h, store } = await mk();
    await h.handle(payload(0));
    await h.handle({ ...payload(0), organizationId: '00000000-0000-4000-8000-0000000000c2' });
    expect(
      store.revisions(
        '00000000-0000-4000-8000-0000000000c2',
        '10000000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000001',
      ),
    ).toHaveLength(1);
    expect(chunkIdempotencyKey(payload(3))).toBe(
      'stt:00000000-0000-4000-8000-0000000000c1:10000000-0000-4000-8000-000000000001:30000000-0000-4000-8000-000000000001:chunk:3',
    );
  });
  it('payload provider is NOT an override without a server-derived actor', async () => {
    const s = await setup({ providers: {}, configs: [] });
    const h = new TranscriptionChunkHandler({
      executor: s.executor,
      store: new InMemoryTranscriptStore(),
      resolveAudio: async () => ({ bytes: new Uint8Array([1]) }),
      resolveActor: async () => undefined,
    });
    const r = await h.handle({ ...payload(0), sttProviderId: 'deepgram' });
    expect(r.status === 'succeeded' ? [] : r.errors.map((e) => e.code)).not.toContain(
      'UNAUTHORIZED_OVERRIDE',
    );
  });
  it('no usable provider -> failed, nothing stored', async () => {
    const s = await setup({ providers: {}, configs: [] });
    const store = new InMemoryTranscriptStore();
    const h = new TranscriptionChunkHandler({
      executor: s.executor,
      store,
      resolveAudio: async () => ({ bytes: new Uint8Array([1]) }),
      resolveActor: async () => undefined,
    });
    const r = await h.handle(payload(0));
    expect(r.status).toBe('failed');
    expect(
      await store.listChunks(
        '00000000-0000-4000-8000-0000000000c1',
        '10000000-0000-4000-8000-000000000001',
        '30000000-0000-4000-8000-000000000001',
      ),
    ).toEqual([]);
  });

  it('notifies after a durable store when the provider returned a job id', async () => {
    const stored: Array<{ provider: string; providerJobId: string; chunkIndex: number }> = [];
    let calls = 0;
    const stt: TranscriptionProvider = {
      providerId: 'assemblyai',
      kind: 'stt',
      async transcribe() {
        calls++;
        return {
          text: 'secret words from the meeting',
          providerJobId: 'tr-store-1',
          segments: [
            { startSec: 0, endSec: 1, text: 'secret words from the meeting', speaker: 'A' },
          ],
          durationSec: 65,
        };
      },
      async getCapabilities() {
        return { batch: true, streaming: false, diarization: true, languages: ['en'] };
      },
      async healthCheck() {
        return { ok: true, timestamp: 'x' };
      },
    };
    const s = await setup({
      providers: { assemblyai: stt },
      configs: [
        {
          name: 'assemblyai',
          type: 'stt',
          adapter: 'assemblyai',
          model: 'universal',
          enabled: true,
          capabilities: ['batch-transcription', 'diarization'],
          cost: { tier: 'free' },
          platformBilled: false,
        },
      ],
    });
    const store = new InMemoryTranscriptStore();
    const h = new TranscriptionChunkHandler({
      executor: s.executor,
      store,
      resolveAudio: async () => ({ bytes: new Uint8Array([1]) }),
      resolveActor: async ({ organizationId }) => admin(organizationId),
      onProviderTranscriptStored: async (info) => {
        stored.push({
          provider: info.provider,
          providerJobId: info.providerJobId,
          chunkIndex: info.chunkIndex,
        });
      },
    });
    await h.handle(payload(0));
    expect(calls).toBe(1);
    expect(stored).toEqual([
      { provider: 'assemblyai', providerJobId: 'tr-store-1', chunkIndex: 0 },
    ]);
    const chunks = await store.listChunks(
      '00000000-0000-4000-8000-0000000000c1',
      '10000000-0000-4000-8000-000000000001',
      '30000000-0000-4000-8000-000000000001',
    );
    expect(chunks[0]?.providerJobId).toBe('tr-store-1');
    await h.handle(payload(0));
    expect(calls).toBe(1);
    expect(stored).toHaveLength(2);
  });

  it('does not notify when putChunk fails', async () => {
    const stored: string[] = [];
    const stt: TranscriptionProvider = {
      providerId: 'assemblyai',
      kind: 'stt',
      async transcribe() {
        return { text: 'secret', providerJobId: 'tr-fail', segments: [], durationSec: 65 };
      },
      async getCapabilities() {
        return { batch: true, streaming: false, diarization: true, languages: ['en'] };
      },
      async healthCheck() {
        return { ok: true, timestamp: 'x' };
      },
    };
    const s = await setup({
      providers: { assemblyai: stt },
      configs: [
        {
          name: 'assemblyai',
          type: 'stt',
          adapter: 'assemblyai',
          model: 'universal',
          enabled: true,
          capabilities: ['batch-transcription', 'diarization'],
          cost: { tier: 'free' },
          platformBilled: false,
        },
      ],
    });
    const inner = new InMemoryTranscriptStore();
    const store = {
      getChunk: inner.getChunk.bind(inner),
      listChunks: inner.listChunks.bind(inner),
      latestRevision: inner.latestRevision.bind(inner),
      putRevision: inner.putRevision.bind(inner),
      putChunk: async () => {
        throw new Error('db write failed');
      },
    };
    const h = new TranscriptionChunkHandler({
      executor: s.executor,
      store,
      resolveAudio: async () => ({ bytes: new Uint8Array([1]) }),
      resolveActor: async ({ organizationId }) => admin(organizationId),
      onProviderTranscriptStored: async (info) => {
        stored.push(info.providerJobId);
      },
    });
    await expect(h.handle(payload(0))).rejects.toThrow(/db write failed/);
    expect(stored).toEqual([]);
  });
});
