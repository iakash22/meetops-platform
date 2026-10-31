/**
 * Phase 7 search over live Postgres (forced RLS, meetops_app role). Skipped unless TEST_DATABASE_URL is set:
 *   TEST_DATABASE_URL=postgresql://meetops_app:...@127.0.0.1:5432/meetops pnpm vitest run test/search.prisma.integration.test.ts
 * The schema must include migration 20261031010000_meeting_search_fts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createPrismaClient,
  withOrganizationContext,
  type DatabaseClient,
} from '@meetops/database';
import { PrismaSearch } from '../src/modules/search/prisma.repository.js';

const url = process.env.TEST_DATABASE_URL;
const ALL = ['meeting', 'transcript', 'summary', 'task'] as const;

describe.skipIf(!url)('Phase 7 PrismaSearch (live RLS)', { timeout: 60_000 }, () => {
  let db: DatabaseClient;
  const orgA = randomUUID();
  const orgB = randomUUID();
  const word = `zebra${randomUUID().slice(0, 6)}`;

  async function seedOrg(org: string, label: string) {
    await db.$executeRaw`SELECT 1`;
    await withOrganizationContext(
      org,
      async (tx) => {
        const meeting = await tx.meeting.create({
          data: {
            organizationId: org,
            title: `${label} ${word} planning`,
            description: 'quarterly',
          },
        });
        await tx.task.create({
          data: { organizationId: org, title: `Follow up on ${word}`, meetingId: meeting.id },
        });
        await tx.report.create({
          data: {
            organizationId: org,
            meetingId: meeting.id,
            title: 'Summary',
            summary: `The team discussed ${word} rollout risks`,
          },
        });
      },
      { client: db },
    );
  }

  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: url! });
    const owner = process.env.TEST_OWNER_DATABASE_URL;
    if (owner) {
      const o = createPrismaClient({ databaseUrl: owner });
      for (const [id, n] of [
        [orgA, 'A'],
        [orgB, 'B'],
      ] as const)
        await o.organization.create({
          data: { id, name: `Search ${n}`, slug: `search-${n.toLowerCase()}-${id.slice(0, 8)}` },
        });
      await o.$disconnect();
    }
    await seedOrg(orgA, 'Alpha');
    await seedOrg(orgB, 'Beta');
  });
  afterAll(async () => db?.$disconnect());

  it('finds meeting, summary and task hits for the caller org only', async () => {
    const s = new PrismaSearch(db);
    const a = await s.search(orgA, { q: word, kinds: ALL, limit: 20 });
    expect(a.map((r) => r.kind).sort()).toEqual(['meeting', 'summary', 'task']);
    expect(a.every((r) => !r.title.includes('Beta'))).toBe(true);
    expect(a.find((r) => r.kind === 'summary')!.snippet).toContain(`\u0002${word}\u0003`);
    const b = await s.search(orgB, { q: word, kinds: ['meeting'], limit: 20 });
    expect(b).toHaveLength(1);
    expect(b[0]!.title).toContain('Beta');
  });

  it('treats the query as data (websearch syntax, no SQL injection)', async () => {
    const s = new PrismaSearch(db);
    await expect(
      s.search(orgA, { q: `'); DROP TABLE meetings; --`, kinds: ALL, limit: 5 }),
    ).resolves.toEqual([]);
    expect(await s.search(orgA, { q: `${word} -planning`, kinds: ['meeting'], limit: 5 })).toEqual(
      [],
    );
  });

  it('strips raw markers from stored text and does not leak the statement timeout', async () => {
    await withOrganizationContext(
      orgA,
      (tx) =>
        tx.task.create({
          data: { organizationId: orgA, title: `marker \u0002${word}fake\u0003 test ${word}` },
        }),
      { client: db },
    );
    const s = new PrismaSearch(db);
    const hits = await s.search(orgA, { q: `marker ${word}`, kinds: ['task'], limit: 5 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.snippet).not.toContain(`\u0002${word}fake`);
    expect(hits[0]!.title.includes('\u0002') || hits[0]!.title.includes('\u0003')).toBe(false);
    const t = await db.$queryRaw<{ statement_timeout: string }[]>`SHOW statement_timeout`;
    expect(t[0]!.statement_timeout).not.toBe('2s');
  });
});
