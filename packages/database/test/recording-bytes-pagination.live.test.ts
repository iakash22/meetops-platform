/**
 * P1-DB-4 live checks: add_recording_session_bytes() and listMeetingsPage().
 * Skipped unless RLS_TEST_APP_URL and RLS_TEST_OWNER_URL are set (throwaway DB only).
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { runWithOrgContext } from '../src/tenant.js';
import { addRecordingSessionBytes } from '../src/index.js';
import {
  decodeMeetingsCursor,
  encodeMeetingsCursor,
  listMeetingsPage,
} from '../src/meetings-page.js';

const APP_URL = process.env.RLS_TEST_APP_URL;
const OWNER_URL = process.env.RLS_TEST_OWNER_URL;
const MAX = 1_400_000_000n;

/** Only the canonical ADR-010 setting (as once the legacy app.current_org_id is dropped). */
function canonicalOnly<T>(
  client: PrismaClient,
  organizationId: string,
  fn: (tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]) => Promise<T>,
): Promise<T> {
  return client.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.current_organization_id', ${organizationId}, true)`;
    return fn(tx);
  });
}

describe.skipIf(!APP_URL || !OWNER_URL)('add_recording_session_bytes (live)', () => {
  const app = new PrismaClient({
    datasources: {
      db: { url: `${APP_URL ?? ''}${APP_URL?.includes('?') ? '&' : '?'}connection_limit=20` },
    },
  });
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL ?? '' } } });
  const org = randomUUID();
  const otherOrg = randomUUID();
  const meetingId = randomUUID();
  const sessionId = randomUUID();
  const capSession = randomUUID();
  const doneSession = randomUUID();
  const add = (o: string, s: string, d: bigint) =>
    runWithOrgContext(app, o, (tx) => addRecordingSessionBytes(tx, s, d));

  it('setup', async () => {
    await owner.organization.createMany({
      data: [
        { id: org, name: 'Bytes', slug: `bytes-${org}` },
        { id: otherOrg, name: 'Other', slug: `bytes-o-${otherOrg}` },
      ],
    });
    await runWithOrgContext(app, org, async (tx) => {
      await tx.meeting.create({ data: { id: meetingId, organizationId: org, title: 'Bytes' } });
      for (const id of [sessionId, capSession, doneSession]) {
        await tx.recordingSession.create({
          data: {
            id,
            organizationId: org,
            meetingId,
            mimeType: 'audio/webm',
            startedAt: new Date(),
          },
        });
      }
      await tx.recordingSession.update({
        where: { id: doneSession },
        data: { status: 'aborted', abortReason: 'user_stopped', abortedAt: new Date() },
      });
    });
  });

  it('returns the new total and defaults to 0', async () => {
    expect(await add(org, sessionId, 10n)).toBe(10n);
    expect(await add(org, sessionId, 5n)).toBe(15n);
  });

  it('parallel increments add up exactly', async () => {
    const results = await Promise.all(Array.from({ length: 40 }, () => add(org, sessionId, 1000n)));
    expect(new Set(results).size).toBe(40);
    const row = await runWithOrgContext(app, org, (tx) =>
      tx.recordingSession.findUniqueOrThrow({ where: { id: sessionId } }),
    );
    expect(row.bytesReceived).toBe(15n + 40_000n);
  });

  it('parallel increments never exceed the max; extras get recording_session_bytes_exceeded', async () => {
    await add(org, capSession, MAX - 950n);
    const settled = await Promise.allSettled(
      Array.from({ length: 20 }, () => add(org, capSession, 100n)),
    );
    const ok = settled.filter((r) => r.status === 'fulfilled');
    const failed = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(9);
    for (const f of failed) expect(String(f.reason)).toMatch(/recording_session_bytes_exceeded/);
    const row = await runWithOrgContext(app, org, (tx) =>
      tx.recordingSession.findUniqueOrThrow({ where: { id: capSession } }),
    );
    expect(row.bytesReceived).toBe(MAX - 50n);
    await expect(add(org, capSession, 51n)).rejects.toThrow(/recording_session_bytes_exceeded/);
    expect(await add(org, capSession, 50n)).toBe(MAX);
  });

  it('works with only the canonical app.current_organization_id setting (M-1)', async () => {
    const fresh = randomUUID();
    await runWithOrgContext(app, org, (tx) =>
      tx.recordingSession.create({
        data: {
          id: fresh,
          organizationId: org,
          meetingId,
          mimeType: 'audio/webm',
          startedAt: new Date(),
        },
      }),
    );
    expect(await canonicalOnly(app, org, (tx) => addRecordingSessionBytes(tx, fresh, 3n))).toBe(3n);
    await expect(
      canonicalOnly(app, otherOrg, (tx) => addRecordingSessionBytes(tx, fresh, 1n)),
    ).rejects.toThrow(/recording_session_not_found/);
  });

  it('rejects delta <= 0, other-org, missing and non-uploading sessions; no org context => not found', async () => {
    await expect(add(org, sessionId, 0n)).rejects.toThrow(/recording_session_bytes_invalid_delta/);
    await expect(add(org, sessionId, -1n)).rejects.toThrow(/recording_session_bytes_invalid_delta/);
    await expect(add(otherOrg, sessionId, 1n)).rejects.toThrow(/recording_session_not_found/);
    await expect(add(org, randomUUID(), 1n)).rejects.toThrow(/recording_session_not_found/);
    await expect(add(org, doneSession, 1n)).rejects.toThrow(/recording_session_not_uploading/);
    await expect(
      app.$queryRaw`SELECT add_recording_session_bytes(${sessionId}::uuid, 1::bigint)`,
    ).rejects.toThrow(/recording_session_not_found/);
  });

  it('the column cannot be pushed past the max directly either (CHECK)', async () => {
    await expect(
      runWithOrgContext(app, org, (tx) =>
        tx.recordingSession.update({ where: { id: sessionId }, data: { bytesReceived: MAX + 1n } }),
      ),
    ).rejects.toThrow();
  });

  it('function is SECURITY INVOKER, pinned search_path, EXECUTE only for meetops_app', async () => {
    const rows = await owner.$queryRaw<
      { definer: boolean; config: string[]; app: boolean; pub: boolean; relay: boolean }[]
    >`
      SELECT p.prosecdef AS definer, p.proconfig AS config,
             has_function_privilege('meetops_app', p.oid, 'EXECUTE') AS app,
             EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS pub,
             COALESCE((SELECT has_function_privilege('meetops_relay', p.oid, 'EXECUTE') FROM pg_roles WHERE rolname = 'meetops_relay'), false) AS relay
      FROM pg_proc p WHERE p.proname = 'add_recording_session_bytes'`;
    expect(rows).toEqual([
      {
        definer: false,
        config: ['search_path=public, pg_temp'],
        app: true,
        pub: false,
        relay: false,
      },
    ]);
    await app.$disconnect();
    await owner.$disconnect();
  });
});

describe.skipIf(!APP_URL || !OWNER_URL)('listMeetingsPage keyset pagination (live)', () => {
  const app = new PrismaClient({ datasources: { db: { url: APP_URL ?? '' } } });
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL ?? '' } } });
  const org = randomUUID();
  const otherOrg = randomUUID();
  const emptyOrg = randomUUID();
  const same = new Date('2026-01-01T00:00:00.000Z');
  const ids: string[] = [];

  it('setup: 7 meetings with equal created_at, 3 newer, 1 deleted, other-org rows', async () => {
    await owner.organization.createMany({
      data: [
        { id: org, name: 'Page', slug: `page-${org}` },
        { id: otherOrg, name: 'PageO', slug: `page-o-${otherOrg}` },
        { id: emptyOrg, name: 'PageE', slug: `page-e-${emptyOrg}` },
      ],
    });
    await runWithOrgContext(app, org, async (tx) => {
      for (let i = 0; i < 7; i++) {
        const m = await tx.meeting.create({
          data: { organizationId: org, title: `same ${i}`, createdAt: same },
        });
        ids.push(m.id);
      }
      for (let i = 1; i <= 3; i++) {
        const m = await tx.meeting.create({
          data: {
            organizationId: org,
            title: `newer ${i}`,
            createdAt: new Date(same.getTime() + i * 1000),
          },
        });
        ids.push(m.id);
      }
      await tx.meeting.create({
        data: { organizationId: org, title: 'gone', deletedAt: new Date() },
      });
    });
    await runWithOrgContext(app, otherOrg, (tx) =>
      tx.meeting.createMany({
        data: Array.from({ length: 5 }, (_, i) => ({
          organizationId: otherOrg,
          title: `o${i}`,
          createdAt: same,
        })),
      }),
    );
  });

  it('pages are stable with equal timestamps: no duplicates, no gaps, (created_at,id) DESC', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const page = await runWithOrgContext(app, org, (tx) =>
        listMeetingsPage(tx, { limit: 3, cursor: cursor ? decodeMeetingsCursor(cursor) : null }),
      );
      expect(page.items.length).toBeLessThanOrEqual(3);
      for (const m of page.items) expect(m.organizationId).toBe(org);
      seen.push(...page.items.map((m) => m.id));
      if (!page.nextCursor) break;
      cursor = encodeMeetingsCursor(page.nextCursor);
    }
    const sameDesc = ids.slice(0, 7).sort().reverse();
    expect(seen).toEqual([ids[9], ids[8], ids[7], ...sameDesc]);
  });

  it('lists with only the canonical app.current_organization_id setting (M-1)', async () => {
    const page = await canonicalOnly(app, org, (tx) => listMeetingsPage(tx, { limit: 100 }));
    expect(page.items).toHaveLength(10);
  });

  it('limit is clamped to 1..100 and non-integers are rejected', async () => {
    const big = await runWithOrgContext(app, org, (tx) => listMeetingsPage(tx, { limit: 10_000 }));
    expect(big.items).toHaveLength(10);
    expect(big.nextCursor).toBeNull();
    const tiny = await runWithOrgContext(app, org, (tx) => listMeetingsPage(tx, { limit: 0 }));
    expect(tiny.items).toHaveLength(1);
    await expect(
      runWithOrgContext(app, org, (tx) => listMeetingsPage(tx, { limit: 2.5 })),
    ).rejects.toThrow('invalid_limit');
  });

  it('cross-org rows never returned; empty org and no context return 0', async () => {
    const other = await runWithOrgContext(app, otherOrg, (tx) =>
      listMeetingsPage(tx, { limit: 100 }),
    );
    expect(other.items).toHaveLength(5);
    expect(other.items.every((m) => m.organizationId === otherOrg)).toBe(true);
    expect(
      (await runWithOrgContext(app, emptyOrg, (tx) => listMeetingsPage(tx))).items,
    ).toHaveLength(0);
    expect((await app.$transaction((tx) => listMeetingsPage(tx))).items).toHaveLength(0);
  });

  it('EXPLAIN uses meetings_org_id_created_at_id_idx (first page and keyset page)', async () => {
    const plans = await runWithOrgContext(owner, org, async (tx) => {
      await tx.$executeRaw`SET LOCAL enable_seqscan = off`;
      // Tiny fixture table: keep the planner off bitmap+sort so the plan shows the ordered (backward) index scan.
      await tx.$executeRaw`SET LOCAL enable_bitmapscan = off`;
      const first = await tx.$queryRaw<{ 'QUERY PLAN': string }[]>`
        EXPLAIN SELECT id FROM meetings
        WHERE org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND deleted_at IS NULL
        ORDER BY created_at DESC, id DESC LIMIT 21`;
      const next = await tx.$queryRaw<{ 'QUERY PLAN': string }[]>`
        EXPLAIN SELECT id FROM meetings
        WHERE org_id = NULLIF(current_setting('app.current_org_id', true), '')::uuid AND deleted_at IS NULL
          AND (created_at, id) < (${same}::timestamptz, ${ids[0]}::uuid)
        ORDER BY created_at DESC, id DESC LIMIT 21`;
      return [first, next].map((p) => p.map((r) => r['QUERY PLAN']).join('\n'));
    });
    for (const plan of plans) {
      expect(plan).toContain('meetings_org_id_created_at_id_idx');
      expect(plan).not.toMatch(/Sort/);
    }
    await app.$disconnect();
    await owner.$disconnect();
  });
});
