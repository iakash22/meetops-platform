/**
 * Unit tests for the media persistence ports over a fake transaction client: the ownership check is read-only and
 * RLS-scoped, and createRecordingChunkPersistence writes chunk_count + every chunk row in ONE transaction, rolling
 * all of it back on any failure. Live counterparts: test/media.live.test.ts.
 */
import { describe, expect, it } from 'vitest';
import {
  MediaPersistenceError,
  createChunkFileObjectRepository,
  createRecordingChunkCountRepository,
  createRecordingChunkPersistence,
  createRecordingOwnershipVerifier,
  type ChunkFileObjectRow,
} from '../src/index.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const OTHER = '44444444-4444-4444-8444-444444444444';
const MEET = '22222222-2222-4222-8222-222222222222';
const REC = '33333333-3333-4333-8333-333333333333';
const ref = { organizationId: ORG, meetingId: MEET, recordingId: REC };

type Stmt = { tx: number; sql: string; values: unknown[] };

/** Records statements per transaction; UPDATE/SELECT match only `match` rows; committed only if fn resolves. */
function fakeClient(opts: { recordingMatches: boolean; failInsertAt?: number }) {
  const statements: Stmt[] = [];
  const committed: number[] = [];
  let n = 0;
  const client = {
    async $transaction<R>(fn: (tx: never) => Promise<R>): Promise<R> {
      const txNo = ++n;
      let inserts = 0;
      const sqlOf = (s: TemplateStringsArray) => s.join('$').replace(/\s+/g, ' ').trim();
      const tx = {
        $executeRaw: async (s: TemplateStringsArray, ...values: unknown[]) => {
          const sql = sqlOf(s);
          statements.push({ tx: txNo, sql, values });
          if (sql.startsWith('SELECT set_config(')) return 1;
          if (sql.startsWith('UPDATE "recordings"')) return opts.recordingMatches ? 1 : 0;
          throw new Error(`unexpected: ${sql}`);
        },
        $queryRaw: async (s: TemplateStringsArray, ...values: unknown[]) => {
          const sql = sqlOf(s);
          statements.push({ tx: txNo, sql, values });
          if (sql.startsWith('SELECT "id" FROM "recordings"'))
            return opts.recordingMatches ? [{ id: REC }] : [];
          if (sql.startsWith('INSERT INTO "file_objects"')) {
            inserts++;
            return inserts === opts.failInsertAt ? [] : [{ id: values[0] }];
          }
          throw new Error(`unexpected: ${sql}`);
        },
      };
      const out = await fn(tx as never);
      committed.push(txNo);
      return out;
    },
  };
  const of = (txNo: number) =>
    statements.filter((s) => s.tx === txNo && !s.sql.startsWith('SELECT set_config('));
  return { client, statements, committed, of, transactions: () => n };
}

const row = (i: number, over: Partial<ChunkFileObjectRow> = {}): ChunkFileObjectRow => ({
  fileObjectId: `00000000-0000-4000-8000-00000000000${i}`,
  index: i,
  storageKey: `organizations/${ORG}/meetings/${MEET}/processed/${REC}/chunks/${String(i).padStart(5, '0')}.wav`,
  sizeBytes: 10 + i,
  mimeType: 'audio/wav',
  sha256: 'a'.repeat(64),
  startMs: i * 1000,
  durationMs: 1000,
  ...over,
});

describe('createRecordingOwnershipVerifier', () => {
  it('runs one read-only, organization-scoped SELECT (org, meeting, id, not deleted)', async () => {
    const db = fakeClient({ recordingMatches: true });
    expect(await createRecordingOwnershipVerifier({ client: db.client }).verifyRecording(ref)).toBe(
      true,
    );
    expect(db.transactions()).toBe(1);
    const sets = db.statements.filter((s) => s.sql.startsWith('SELECT set_config('));
    expect(sets.map((s) => s.values[1])).toEqual([ORG, ORG]);
    const [q] = db.of(1);
    expect(q!.sql).toMatch(
      /^SELECT "id" FROM "recordings" WHERE "org_id" = .* AND "deleted_at" IS NULL$/,
    );
    expect(q!.values).toEqual([ORG, REC, MEET]);
  });

  it('returns false when no row matches (other organization, other meeting, missing, deleted)', async () => {
    const db = fakeClient({ recordingMatches: false });
    expect(await createRecordingOwnershipVerifier({ client: db.client }).verifyRecording(ref)).toBe(
      false,
    );
  });

  it('rejects a non-UUID organization before touching the database', async () => {
    const db = fakeClient({ recordingMatches: true });
    await expect(
      createRecordingOwnershipVerifier({ client: db.client }).verifyRecording({
        ...ref,
        organizationId: 'x',
      }),
    ).rejects.toThrow(TypeError);
    expect(db.transactions()).toBe(0);
  });
});

describe('createRecordingChunkPersistence', () => {
  it('requires a bucket', () => {
    expect(() => createRecordingChunkPersistence({ bucket: '' })).toThrow(TypeError);
  });

  it('writes chunk_count (= chunks.length) first, then every chunk row, in ONE transaction', async () => {
    const db = fakeClient({ recordingMatches: true });
    const p = createRecordingChunkPersistence({
      client: db.client,
      bucket: 'bkt',
      provider: 'minio',
    });
    await p.persistChunks({ ...ref, chunks: [row(0), row(1), row(2)] });
    expect(db.transactions()).toBe(1);
    expect(db.committed).toEqual([1]);
    const stmts = db.of(1);
    expect(stmts.map((s) => s.sql.split(' ').slice(0, 3).join(' '))).toEqual([
      'UPDATE "recordings" SET',
      'INSERT INTO "file_objects"',
      'INSERT INTO "file_objects"',
      'INSERT INTO "file_objects"',
    ]);
    expect(stmts[0]!.sql).toMatch(/"deleted_at" IS NULL$/);
    expect(stmts[0]!.values).toEqual([3, ORG, REC, MEET]);
    expect(stmts[1]!.values.slice(0, 5)).toEqual([row(0).fileObjectId, ORG, MEET, 'minio', 'bkt']);
  });

  it('a recording that does not match (forged job) aborts before any chunk row and commits nothing', async () => {
    const db = fakeClient({ recordingMatches: false });
    const p = createRecordingChunkPersistence({ client: db.client, bucket: 'bkt' });
    await expect(p.persistChunks({ ...ref, chunks: [row(0), row(1)] })).rejects.toMatchObject({
      code: 'chunk_count_not_updated',
    });
    expect(db.committed).toEqual([]);
    expect(db.of(1).filter((s) => s.sql.startsWith('INSERT'))).toEqual([]);
  });

  it('a chunk row conflict rolls back the count and the earlier rows (same transaction)', async () => {
    const db = fakeClient({ recordingMatches: true, failInsertAt: 2 });
    const p = createRecordingChunkPersistence({ client: db.client, bucket: 'bkt' });
    await expect(
      p.persistChunks({ ...ref, chunks: [row(0), row(1), row(2)] }),
    ).rejects.toMatchObject({
      code: 'chunk_file_object_conflict',
    });
    expect(db.transactions()).toBe(1);
    expect(db.committed).toEqual([]);
  });

  it('validates before opening a transaction: empty, too many, duplicate index, bad key, foreign key prefix', async () => {
    const db = fakeClient({ recordingMatches: true });
    const p = createRecordingChunkPersistence({ client: db.client, bucket: 'bkt' });
    const bad: Array<[ChunkFileObjectRow[], string]> = [
      [[], 'invalid_chunk_count'],
      [Array.from({ length: 10001 }, () => row(0)), 'invalid_chunk_count'],
      [[row(0), row(0)], 'invalid_chunk_row'],
      [[row(0, { storageKey: row(1).storageKey })], 'invalid_chunk_row'],
      [[row(0, { storageKey: row(0).storageKey.replace(ORG, OTHER) })], 'invalid_chunk_row'],
      [[row(0, { sha256: 'A'.repeat(64) })], 'invalid_chunk_row'],
    ];
    for (const [chunks, code] of bad) {
      const err = await p.persistChunks({ ...ref, chunks }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MediaPersistenceError);
      expect(err).toMatchObject({ code });
    }
    expect(db.transactions()).toBe(0);
  });
});

describe('existing ports keep their contracts', () => {
  it('setChunkCount and upsertChunkFileObjects still each run in their own transaction', async () => {
    const db = fakeClient({ recordingMatches: true });
    await createChunkFileObjectRepository({
      client: db.client,
      bucket: 'bkt',
    }).upsertChunkFileObjects({
      ...ref,
      chunks: [row(0)],
    });
    await createRecordingChunkCountRepository({ client: db.client }).setChunkCount({
      ...ref,
      chunkCount: 1,
    });
    expect(db.committed).toEqual([1, 2]);
    // setChunkCount keeps its original predicate (no deleted_at filter).
    expect(db.of(2)[0]!.sql).not.toMatch(/deleted_at/);
    await expect(
      createRecordingChunkCountRepository({ client: db.client }).setChunkCount({
        ...ref,
        chunkCount: 0,
      }),
    ).rejects.toMatchObject({ code: 'invalid_chunk_count' });
  });

  it('setChunkCount still throws chunk_count_not_updated when no row matches', async () => {
    const db = fakeClient({ recordingMatches: false });
    await expect(
      createRecordingChunkCountRepository({ client: db.client }).setChunkCount({
        ...ref,
        chunkCount: 2,
      }),
    ).rejects.toMatchObject({ code: 'chunk_count_not_updated' });
  });
});
