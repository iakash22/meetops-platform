/**
 * P7 meeting analytics over live Postgres (forced RLS, meetops_app role). Skipped unless TEST_DATABASE_URL is set
 * (TEST_OWNER_DATABASE_URL creates the orgs), like search.prisma.integration.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createPrismaClient,
  withOrganizationContext,
  type DatabaseClient,
} from '@meetops/database';
import { PrismaMeetingRepository } from '../src/modules/meetings/infrastructure/prisma.repository.js';

const url = process.env.TEST_DATABASE_URL;
const from = new Date('2026-10-01T00:00:00Z');
const to = new Date('2026-11-01T00:00:00Z');

describe.skipIf(!url)('PrismaMeetingRepository.analytics (live RLS)', { timeout: 60_000 }, () => {
  let db: DatabaseClient;
  const orgA = randomUUID();
  const orgB = randomUUID();
  const orgEmpty = randomUUID();

  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: url! });
    const owner = process.env.TEST_OWNER_DATABASE_URL;
    if (owner) {
      const o = createPrismaClient({ databaseUrl: owner });
      for (const id of [orgA, orgB, orgEmpty])
        await o.organization.create({
          data: { id, name: `Analytics ${id.slice(0, 4)}`, slug: `analytics-${id.slice(0, 8)}` },
        });
      await o.$disconnect();
    }
    const seed = (
      org: string,
      rows: { source?: 'upload' | 'extension'; durationSec?: number; createdAt: Date }[],
    ) =>
      withOrganizationContext(
        org,
        async (tx) => {
          for (const r of rows)
            await tx.meeting.create({ data: { organizationId: org, title: 'm', ...r } });
        },
        { client: db },
      );
    await seed(orgA, [
      { source: 'extension', durationSec: 60, createdAt: new Date('2026-10-02T10:00:00Z') },
      { source: 'upload', createdAt: new Date('2026-10-02T23:00:00Z') },
    ]);
    await seed(orgB, [
      { source: 'upload', durationSec: 999, createdAt: new Date('2026-10-02T10:00:00Z') },
    ]);
  });
  afterAll(async () => db?.$disconnect());

  it('counts only the caller org, buckets in UTC, and is empty for an empty org', async () => {
    const repo = new PrismaMeetingRepository(db);
    const a = await repo.analytics(orgA, { from, to, bucket: 'day' });
    expect(a.total).toBe(2);
    expect(a.bySource).toEqual([
      { source: 'extension', count: 1 },
      { source: 'upload', count: 1 },
    ]);
    expect(a.duration).toEqual({ measured: 1, totalSec: 60, averageSec: 60 });
    expect(a.periods.map((p) => [p.start.toISOString(), p.count])).toEqual([
      ['2026-10-02T00:00:00.000Z', 2],
    ]);
    const e = await repo.analytics(orgEmpty, { from, to, bucket: 'week' });
    expect(e).toEqual({
      total: 0,
      bySource: [],
      byStatus: [],
      duration: { measured: 0, totalSec: 0, averageSec: null },
      periods: [],
    });
  });
});
