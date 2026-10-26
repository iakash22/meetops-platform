/**
 * ADR-010 phase A (2026-10-24): recording_session_chunks.storage_key accepts both org/{organizationId}/ and
 * organizations/{organizationId}/, still pinned to the row's org_id. Skipped unless the live RLS env is set.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runWithOrgContext } from '../src/tenant.js';

const APP_URL = process.env.RLS_TEST_APP_URL;
const OWNER_URL = process.env.RLS_TEST_OWNER_URL;

describe.skipIf(!APP_URL || !OWNER_URL)(
  'storage key prefix transition (live, ADR-010 phase A)',
  () => {
    const app = new PrismaClient({ datasources: { db: { url: APP_URL ?? '' } } });
    const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL ?? '' } } });
    const organizationId = randomUUID();
    const otherOrg = randomUUID();
    const sessionId = randomUUID();
    let seq = 0;

    const insert = (storageKey: string) =>
      runWithOrgContext(app, organizationId, (tx) =>
        tx.recordingSessionChunk.create({
          data: { organizationId, sessionId, seq: seq++, sizeBytes: 1, storageKey },
        }),
      );

    beforeAll(async () => {
      await owner.organization.createMany({
        data: [
          { id: organizationId, name: 'K', slug: `k-${organizationId}` },
          { id: otherOrg, name: 'K2', slug: `k2-${otherOrg}` },
        ],
      });
      await runWithOrgContext(owner, organizationId, async (tx) => {
        const meeting = await tx.meeting.create({ data: { organizationId, title: 'k' } });
        await tx.recordingSession.create({
          data: {
            id: sessionId,
            organizationId,
            meetingId: meeting.id,
            mimeType: 'audio/webm',
            startedAt: new Date(),
          },
        });
      });
    });

    afterAll(async () => {
      await app.$disconnect();
      await owner.$disconnect();
    });

    it.each(['org', 'organizations', 'tmp/session-chunks/org', 'tmp/session-chunks/organizations'])(
      'accepts %s/{organizationId}/... keys',
      async (prefix) => {
        const row = await insert(
          `${prefix}/${organizationId}/meetings/m/sessions/${sessionId}/${randomUUID()}.part`,
        );
        expect(row.storageKey.startsWith(`${prefix}/${organizationId}/`)).toBe(true);
      },
    );

    it.each([
      ['org/ with another organization', () => `org/${otherOrg}/x.part`],
      ['organizations/ with another organization', () => `organizations/${otherOrg}/x.part`],
      ['no prefix', () => `${organizationId}/x.part`],
      ['old plural typo orgs/', () => `orgs/${organizationId}/x.part`],
      ['prefix without separator', () => `organizations${organizationId}/x.part`],
      ['organization id without trailing slash', () => `organizations/${organizationId}`],
      ['garbage', () => 'not-a-key'],
      ['tmp/ org/ with another organization', () => `tmp/session-chunks/org/${otherOrg}/x.part`],
      [
        'tmp/ organizations/ with another organization',
        () => `tmp/session-chunks/organizations/${otherOrg}/x.part`,
      ],
      ['tmp/ without org segment', () => `tmp/session-chunks/${organizationId}/x.part`],
      ['other tmp/ prefix', () => `tmp/other/organizations/${organizationId}/x.part`],
      ['tmp/ without trailing slash', () => `tmp/session-chunks/organizations/${organizationId}`],
      ['tmp/ garbage', () => 'tmp/session-chunks/not-a-key'],
      [
        'nested tmp/ prefix',
        () => `tmp/session-chunks/tmp/session-chunks/org/${organizationId}/x.part`,
      ],
    ])('rejects %s', async (_label, key) => {
      await expect(insert(key())).rejects.toThrow(
        /recording_session_chunks_key_check|23514|check constraint/,
      );
    });
  },
);
