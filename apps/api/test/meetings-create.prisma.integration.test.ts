/**
 * #440: manual meeting create (POST /orgs/:org/meetings) over live Postgres (forced RLS, meetops_app role).
 * Skipped unless TEST_DATABASE_URL is set (TEST_OWNER_DATABASE_URL creates the orgs), like
 * analytics.prisma.integration.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createPrismaClient,
  withOrganizationContext,
  type DatabaseClient,
} from '@meetops/database';
import { PrismaMeetingRepository } from '../src/modules/meetings/infrastructure/prisma.repository.js';
import { MeetingProjectInvalidError } from '../src/modules/meetings/domain/meeting.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('PrismaMeetingRepository.create (live RLS)', { timeout: 60_000 }, () => {
  let db: DatabaseClient;
  const orgA = randomUUID();
  const orgB = randomUUID();
  const projA = randomUUID();
  const projB = randomUUID();

  beforeAll(async () => {
    db = createPrismaClient({ databaseUrl: url! });
    const owner = process.env.TEST_OWNER_DATABASE_URL;
    if (owner) {
      const o = createPrismaClient({ databaseUrl: owner });
      for (const id of [orgA, orgB])
        await o.organization.create({
          data: { id, name: `Create ${id.slice(0, 4)}`, slug: `mcreate-${id.slice(0, 8)}` },
        });
      await o.$disconnect();
    }
    for (const [org, id] of [
      [orgA, projA],
      [orgB, projB],
    ] as const)
      await withOrganizationContext(
        org,
        (tx) =>
          tx.project.create({
            data: {
              id,
              organizationId: org,
              name: `P ${id.slice(0, 4)}`,
              key: `P${id.slice(0, 4).toUpperCase()}`,
            },
          }),
        { client: db },
      );
  });
  afterAll(async () => db?.$disconnect());

  it('inserts a scheduled meeting in the caller org, readable only there', async () => {
    const repo = new PrismaMeetingRepository(db);
    const startedAt = new Date('2026-11-05T10:00:00Z');
    const m = await repo.create(orgA, {
      title: 'Kickoff',
      source: 'upload',
      startedAt,
      projectId: projA,
      createdById: null,
    });
    expect(m).toMatchObject({
      organizationId: orgA,
      projectId: projA,
      title: 'Kickoff',
      source: 'upload',
      status: 'scheduled',
      externalMeetingId: null,
    });
    expect(m.startedAt?.toISOString()).toBe(startedAt.toISOString());
    expect(await repo.findById(orgA, m.id)).toMatchObject({ id: m.id });
    expect(await repo.findById(orgB, m.id)).toBeNull();
    // Several manual meetings coexist (null externalMeetingId does not collide on the unique index).
    const m2 = await repo.create(orgA, {
      title: 'Second',
      source: 'upload',
      startedAt: null,
      projectId: null,
      createdById: null,
    });
    expect(m2.id).not.toBe(m.id);
  });

  it('rejects a project of another org (or a missing one) with MeetingProjectInvalidError', async () => {
    const repo = new PrismaMeetingRepository(db);
    const base = { title: 'x', source: 'upload' as const, startedAt: null, createdById: null };
    await expect(repo.create(orgA, { ...base, projectId: projB })).rejects.toBeInstanceOf(
      MeetingProjectInvalidError,
    );
    await expect(repo.create(orgA, { ...base, projectId: randomUUID() })).rejects.toBeInstanceOf(
      MeetingProjectInvalidError,
    );
  });
});
