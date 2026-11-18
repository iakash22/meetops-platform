import { describe, expect, it } from 'vitest';
import type { DatabaseTransaction } from '@meetops/database';
import { createOrgScopedTranscriptRepository } from '../src/ai/prisma-repository.js';
import type { TranscriptRevisionWrite } from '../src/ai/repository.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const MEET = '22222222-2222-4222-8222-222222222222';
const REC = '33333333-3333-4333-8333-333333333333';

function fakeTx(
  o: {
    latestRevision?: number;
    insertRows?: Array<{ id: string }>;
    executeResult?: number;
    mergeState?: unknown;
    providerJobId?: string | null;
  } = {},
) {
  const calls: Array<{ op: string; args: unknown; values?: unknown[] }> = [];
  const sql = (strings: TemplateStringsArray) => strings.join('?');
  const tx = {
    calls,
    meeting: {
      findFirst: async (args: unknown) => (
        calls.push({ op: 'meeting.findFirst', args }),
        { id: MEET, organizationId: ORG }
      ),
    },
    recording: { findFirst: async () => ({ id: REC, meetingId: MEET, chunkCount: 2 }) },
    transcript: {
      findFirst: async (args: {
        where: { revision: unknown };
        select: Record<string, boolean>;
      }) => {
        calls.push({ op: 'transcript.findFirst', args });
        if (args.select.providerJobId) return { providerJobId: o.providerJobId ?? null };
        if (args.where.revision === 0) return { id: 'anchor' };
        if (args.select.mergeState)
          return o.mergeState === undefined ? null : { mergeState: o.mergeState };
        return o.latestRevision === undefined ? null : { revision: o.latestRevision };
      },
      updateMany: async (args: unknown) => (
        calls.push({ op: 'transcript.updateMany', args }),
        { count: 1 }
      ),
    },
    transcriptChunk: {
      findMany: async () => [
        { segments: { chunkIndex: 0, segments: [], provider: 'assemblyai' } },
        { segments: { bogus: true } },
      ],
    },
    transcriptSegment: {
      createMany: async (args: unknown) => (
        calls.push({ op: 'segments.createMany', args }),
        { count: 1 }
      ),
    },
    $executeRaw: async (s: TemplateStringsArray, ...values: unknown[]) => (
      calls.push({ op: 'executeRaw', args: sql(s), values }),
      o.executeResult ?? 1
    ),
    $queryRaw: async (s: TemplateStringsArray) => (
      calls.push({ op: 'queryRaw', args: sql(s) }),
      o.insertRows ?? [{ id: 't1' }]
    ),
  };
  return tx as unknown as DatabaseTransaction & { calls: typeof calls };
}

const write = (over: Partial<TranscriptRevisionWrite> = {}): TranscriptRevisionWrite => ({
  organizationId: ORG,
  meetingId: MEET,
  recordingId: REC,
  provider: 'assemblyai',
  revision: 1,
  status: 'ready',
  language: 'en',
  fullText: 'hi',
  segments: [
    { sequence: 0, speakerLabel: 'A', startMs: 0, endMs: 10, text: 'hi', confidence: 0.9 },
  ],
  mergeState: { revision: 1, contentHash: 'h' } as unknown as TranscriptRevisionWrite['mergeState'],
  ...over,
});

describe('Prisma transcript repository', () => {
  it('scopes meeting lookups to the organization', async () => {
    const tx = fakeTx();
    await createOrgScopedTranscriptRepository(tx, ORG).findMeeting(MEET);
    expect(tx.calls[0]?.args).toMatchObject({
      where: { id: MEET, organizationId: ORG, deletedAt: null },
    });
  });

  it('first write wins for chunk results (ON CONFLICT DO NOTHING)', async () => {
    const chunk = {
      chunkIndex: 0,
      startSec: 0,
      durationSec: 600,
      provider: 'assemblyai',
      segments: [],
    } as never;
    expect(
      await createOrgScopedTranscriptRepository(fakeTx({ executeResult: 1 }), ORG).putChunkResult(
        MEET,
        REC,
        chunk,
      ),
    ).toBe(true);
    const tx = fakeTx({ executeResult: 0 });
    expect(
      await createOrgScopedTranscriptRepository(tx, ORG).putChunkResult(MEET, REC, chunk),
    ).toBe(false);
    expect(String(tx.calls.find((c) => c.op === 'executeRaw')?.args)).toContain(
      'ON CONFLICT ("transcript_id", "chunk_index") DO NOTHING',
    );
  });

  it('writes transcripts.provider_job_id on the revision-0 anchor when the STT job returns one', async () => {
    const chunk = {
      chunkIndex: 0,
      startSec: 0,
      durationSec: 600,
      overlapSec: 0,
      provider: 'assemblyai',
      model: 'universal',
      receivedAt: '2026-11-18T07:00:00.000Z',
      providerJobId: 'tr-persist-1',
      segments: [{ startSec: 0, endSec: 1, text: 'hi' }],
    };
    const tx = fakeTx({ executeResult: 1 });
    expect(
      await createOrgScopedTranscriptRepository(tx, ORG).putChunkResult(MEET, REC, chunk),
    ).toBe(true);
    const insert = tx.calls.find(
      (c) => c.op === 'executeRaw' && String(c.args).includes('"transcript_chunks"'),
    );
    expect(String(insert?.args)).not.toContain('"provider_job_id"');
    expect(tx.calls.find((c) => c.op === 'transcript.updateMany')?.args).toMatchObject({
      where: { organizationId: ORG, id: 'anchor', revision: 0 },
      data: { providerJobId: 'tr-persist-1' },
    });
  });

  it('does not write provider_job_id when the chunk insert loses the first-write-wins race', async () => {
    const chunk = {
      chunkIndex: 0,
      startSec: 0,
      durationSec: 600,
      overlapSec: 0,
      provider: 'assemblyai',
      model: 'universal',
      receivedAt: '2026-11-18T07:00:00.000Z',
      providerJobId: 'tr-late',
      segments: [],
    };
    const tx = fakeTx({ executeResult: 0 });
    expect(
      await createOrgScopedTranscriptRepository(tx, ORG).putChunkResult(MEET, REC, chunk),
    ).toBe(false);
    expect(tx.calls.some((c) => c.op === 'transcript.updateMany')).toBe(false);
  });

  it('reads transcripts.provider_job_id from the anchor (undefined when unset)', async () => {
    expect(
      await createOrgScopedTranscriptRepository(
        fakeTx({ providerJobId: 'tr-stored' }),
        ORG,
      ).getProviderJobId(MEET, REC),
    ).toBe('tr-stored');
    expect(
      await createOrgScopedTranscriptRepository(
        fakeTx({ providerJobId: null }),
        ORG,
      ).getProviderJobId(MEET, REC),
    ).toBeUndefined();
  });

  it('drops malformed chunk JSON when listing', async () => {
    const chunks = await createOrgScopedTranscriptRepository(fakeTx(), ORG).listChunkResults(
      MEET,
      REC,
    );
    expect(chunks).toHaveLength(1);
  });

  it('returns the merge state of the latest merged revision only when well-formed', async () => {
    expect(
      await createOrgScopedTranscriptRepository(
        fakeTx({ mergeState: { revision: 2, contentHash: 'x' } }),
        ORG,
      ).latestTranscript(MEET, REC),
    ).toMatchObject({ revision: 2 });
    expect(
      await createOrgScopedTranscriptRepository(
        fakeTx({ mergeState: { nope: 1 } }),
        ORG,
      ).latestTranscript(MEET, REC),
    ).toBeUndefined();
  });

  it('compare-and-set: writes revision and segments when prev matches', async () => {
    const tx = fakeTx();
    expect(
      await createOrgScopedTranscriptRepository(tx, ORG).writeTranscriptRevision(write(), 0),
    ).toBe(true);
    expect(tx.calls.find((c) => c.op === 'segments.createMany')?.args).toMatchObject({
      data: [{ organizationId: ORG, transcriptId: 't1', revision: 1 }],
    });
  });

  it('compare-and-set: loses on stale prev, revision gap or a concurrent insert', async () => {
    expect(
      await createOrgScopedTranscriptRepository(
        fakeTx({ latestRevision: 1 }),
        ORG,
      ).writeTranscriptRevision(write(), 0),
    ).toBe(false);
    expect(
      await createOrgScopedTranscriptRepository(fakeTx(), ORG).writeTranscriptRevision(
        write({ revision: 3 }),
        0,
      ),
    ).toBe(false);
    const tx = fakeTx({ insertRows: [] });
    expect(
      await createOrgScopedTranscriptRepository(tx, ORG).writeTranscriptRevision(write(), 0),
    ).toBe(false);
    expect(tx.calls.some((c) => c.op === 'segments.createMany')).toBe(false);
  });

  it('rejects a write for another organization', async () => {
    await expect(
      createOrgScopedTranscriptRepository(fakeTx(), ORG).writeTranscriptRevision(
        write({ organizationId: '44444444-4444-4444-8444-444444444444' }),
        0,
      ),
    ).rejects.toThrow(/cross-organization/);
  });
});
