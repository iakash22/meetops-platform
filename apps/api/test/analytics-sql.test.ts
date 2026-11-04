import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { PrismaMeetingRepository } from '../src/modules/meetings/infrastructure/prisma.repository.js';

/**
 * Credential-free coverage of the analytics Prisma path (the live test needs TEST_DATABASE_URL). The mocked
 * transaction captures the real $queryRaw template, so the shape checks run against the SQL that ships.
 * #400 L2: mock-only. Row-level security and tenant isolation are NOT proven here; the live suites
 * (analytics.prisma.integration.test.ts, task-analytics.prisma.integration.test.ts) remain the source of truth.
 */
type Raw = { sql: string; values: unknown[] };

function mockDb(opts: {
  sources?: { source: string; n: number }[];
  statuses?: { status: string; n: number }[];
  measured?: number;
  sum?: number | null;
  periods?: { start: Date; count: bigint }[];
}) {
  const raw: Raw[] = [];
  const where: unknown[] = [];
  const tx = {
    $executeRaw: () => Promise.resolve(1),
    $executeRawUnsafe: () => Promise.resolve(0),
    meeting: {
      groupBy: (a: { by: string[]; where: unknown }) => {
        where.push(a.where);
        const rows =
          a.by[0] === 'source'
            ? (opts.sources ?? []).map((r) => ({ source: r.source, _count: { _all: r.n } }))
            : (opts.statuses ?? []).map((r) => ({ status: r.status, _count: { _all: r.n } }));
        return Promise.resolve(rows);
      },
      aggregate: (a: { where: unknown }) => {
        where.push(a.where);
        return Promise.resolve({
          _count: { _all: opts.measured ?? 0 },
          _sum: { durationSec: opts.sum ?? null },
        });
      },
    },
    $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
      raw.push({ sql: strings.join('$?').replace(/\s+/g, ' '), values });
      return Promise.resolve(opts.periods ?? []);
    },
  };
  const db = { $transaction: (fn: (t: typeof tx) => Promise<unknown>) => fn(tx) };
  return { repo: new PrismaMeetingRepository(db as never), raw, where };
}

const ORG = randomUUID();
const Q = {
  from: new Date('2026-10-01T00:00:00Z'),
  to: new Date('2026-11-01T00:00:00Z'),
  bucket: 'week' as const,
};

describe('analytics raw SQL (static shape, captured from the repository)', () => {
  it('filters org, soft deletes and the half-open range, all as bound values', async () => {
    const { repo, raw, where } = mockDb({});
    await repo.analytics(ORG, Q);
    expect(raw).toHaveLength(1);
    const { sql, values } = raw[0]!;
    expect(sql).toMatch(/WHERE org_id = \$\?::uuid/);
    expect(sql).toMatch(/deleted_at IS NULL/);
    expect(sql).toMatch(/created_at >= \$\? AND created_at < \$\?/);
    expect(values).toEqual([Q.bucket, ORG, Q.from, Q.to]);
    // The bucket is bound, never spliced into the SQL text.
    expect(sql).not.toMatch(/\bweek\b/);
    // Every Prisma aggregate is org-scoped and skips deleted rows too.
    for (const w of where)
      expect(w).toMatchObject({
        organizationId: ORG,
        deletedAt: null,
        createdAt: { gte: Q.from, lt: Q.to },
      });
  });

  it('groups by a UTC date_trunc period and orders by it', () => {
    return (async () => {
      const { repo, raw } = mockDb({});
      await repo.analytics(ORG, Q);
      const { sql } = raw[0]!;
      expect(sql).toMatch(
        /date_trunc\(\$\?::text, created_at AT TIME ZONE 'UTC'\) AT TIME ZONE 'UTC' AS start/,
      );
      expect(sql).toMatch(/GROUP BY 1 ORDER BY 1/);
      expect(sql).not.toMatch(/now\(\)|current_setting\('TimeZone'|LOCALTIME/i);
    })();
  });
});

describe('analytics Prisma mapping (mocked transaction)', () => {
  it('maps counts, sorts alphabetically, averages measured meetings and converts bigint periods', async () => {
    const { repo } = mockDb({
      sources: [
        { source: 'upload', n: 2 },
        { source: 'extension', n: 3 },
      ],
      statuses: [
        { status: 'ready', n: 4 },
        { status: 'failed', n: 1 },
      ],
      measured: 2,
      sum: 900,
      periods: [
        { start: new Date('2026-10-05T00:00:00Z'), count: 3n },
        { start: new Date('2026-10-12T00:00:00Z'), count: 2n },
      ],
    });
    const r = await repo.analytics(ORG, Q);
    expect(r).toEqual({
      total: 5,
      bySource: [
        { source: 'extension', count: 3 },
        { source: 'upload', count: 2 },
      ],
      byStatus: [
        { status: 'failed', count: 1 },
        { status: 'ready', count: 4 },
      ],
      duration: { measured: 2, totalSec: 900, averageSec: 450 },
      periods: [
        { start: new Date('2026-10-05T00:00:00Z'), count: 3 },
        { start: new Date('2026-10-12T00:00:00Z'), count: 2 },
      ],
    });
    expect(typeof r.periods[0]!.count).toBe('number');
  });

  it('no measured meetings: averageSec is null and a null SUM becomes 0', async () => {
    const { repo } = mockDb({ sources: [{ source: 'upload', n: 1 }], measured: 0, sum: null });
    const r = await repo.analytics(ORG, Q);
    expect(r.duration).toEqual({ measured: 0, totalSec: 0, averageSec: null });
    expect(r.periods).toEqual([]);
  });

  it('only counts meetings with a duration in the average', async () => {
    const { repo, where } = mockDb({});
    await repo.analytics(ORG, Q);
    expect(where.at(-1)).toMatchObject({ durationSec: { not: null } });
  });
});
