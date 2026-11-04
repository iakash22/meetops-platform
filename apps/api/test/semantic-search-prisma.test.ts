import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { SearchTimeoutError } from '../src/modules/search/prisma.repository.js';
import { PrismaSemanticSearch, SEMANTIC_EMBEDDING_DIMS } from '../src/modules/search/semantic.js';

/** Credential-free coverage of PrismaSemanticSearch (the live test needs TEST_DATABASE_URL). */
const VEC = Array.from({ length: SEMANTIC_EMBEDDING_DIMS }, (_, i) => (i % 7) / 7);
const row = (score: number) => ({
  kind: 'transcript',
  id: randomUUID(),
  meeting_id: randomUUID(),
  title: 't',
  snippet: 's',
  score,
  start_ms: 5,
  occurred_at: new Date('2026-10-01T00:00:00Z'),
});

function mockDb(query: (sql: string, ...args: unknown[]) => Promise<unknown>) {
  const unsafe: string[] = [];
  const calls: unknown[][] = [];
  const tx = {
    $executeRaw: () => Promise.resolve(1),
    $executeRawUnsafe: (sql: string) => {
      unsafe.push(sql);
      return Promise.resolve(0);
    },
    $queryRawUnsafe: (sql: string, ...args: unknown[]) => {
      calls.push(args);
      return query(sql, ...args);
    },
  };
  const db = { $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
  return { s: new PrismaSemanticSearch(db as never), unsafe, calls };
}
const input = (limit: number) => ({
  vector: VEC,
  model: 'm',
  kinds: ['transcript'] as const,
  limit,
});

describe('PrismaSemanticSearch (mocked transaction)', () => {
  it.each([
    ['message', Object.assign(new Error('canceling statement due to statement timeout'), {})],
    [
      'Prisma P2010 meta only',
      Object.assign(new Error('Raw query failed'), { code: 'P2010', meta: { code: '57014' } }),
    ],
    ['pg SQLSTATE code', Object.assign(new Error('query failed'), { code: '57014' })],
  ])('maps a statement timeout (%s) to SearchTimeoutError under a 2 s limit', async (_n, err) => {
    const { s, unsafe } = mockDb(() => Promise.reject(err));
    await expect(s.search(randomUUID(), input(5))).rejects.toBeInstanceOf(SearchTimeoutError);
    expect(unsafe).toEqual([`SET LOCAL statement_timeout = '2000ms'`]);
  });

  it('#400 L1: "57014" elsewhere in the meta is not a timeout', async () => {
    const other = Object.assign(new Error('Raw query failed'), {
      code: 'P2010',
      meta: { code: '23505', target: 'row-57014' },
    });
    const { s } = mockDb(() => Promise.reject(other));
    await expect(s.search(randomUUID(), input(5))).rejects.toBe(other);
  });

  it('rethrows other errors unchanged', async () => {
    const boom = new Error('connection reset');
    const { s } = mockDb(() => Promise.reject(boom));
    await expect(s.search(randomUUID(), input(5))).rejects.toBe(boom);
  });

  it.each([
    [0, 1],
    [-3, 1],
    [1, 1],
    [7, 7],
    [20, 20],
    [21, 20],
    [1e9, 20],
    [2.7, 2],
    [Number.NaN, 20],
    [Number.POSITIVE_INFINITY, 20],
  ])('caps limit %s to %s (bound as the 5th parameter, an integer 1-20)', async (limit, want) => {
    const { s, calls } = mockDb(() => Promise.resolve([]));
    await s.search(randomUUID(), input(limit));
    expect(calls[0]![4]).toBe(want);
    expect(Number.isInteger(calls[0]![4])).toBe(true);
  });

  it('clamps scores to [-1, 1] and maps non-finite scores to -1', async () => {
    const { s } = mockDb(() =>
      Promise.resolve([row(1.0000002), row(0.5), row(-1.5), row(Number.NaN)]),
    );
    const r = await s.search(randomUUID(), input(5));
    expect(r.map((x) => x.score)).toEqual([1, 0.5, -1, -1]);
    expect(r[0]).toMatchObject({ startMs: 5, occurredAt: '2026-10-01T00:00:00.000Z' });
  });
});
