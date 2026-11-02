/**
 * Calendar sync claim/lease on a real Postgres, as meetops_app (forced RLS). Proves the claim is timed by the
 * database clock (a connection reached late in a long sweep still gets a full lease), that only one of several
 * concurrent claims wins, and that once a lease expires and another sweep re-claims the connection, the old
 * holder's applySync / recordFailure writes are refused (claim token = the claimed next_sync_at).
 *
 * Skipped unless RLS_TEST_APP_URL and RLS_TEST_ADMIN_URL are set (see /workspace/livedb-346.sh-style runs).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createCalendarSyncRepository } from '../src/calendar-sync.js';

const APP_URL = process.env.RLS_TEST_APP_URL;
const ADMIN_URL = process.env.RLS_TEST_ADMIN_URL;
const live = Boolean(APP_URL && ADMIN_URL);
if (!live)
  console.warn('[calendar-sync-lease] skipped: missing RLS_TEST_APP_URL / RLS_TEST_ADMIN_URL');

const ORG = randomUUID();
const USER = randomUUID();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!live)('calendar sync lease (live)', () => {
  const app = new PrismaClient({ datasources: { db: { url: APP_URL ?? '' } } });
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL ?? '' } } });
  const repo = createCalendarSyncRepository({ client: app });
  const ids: string[] = [];

  /** One active connection row inserted by the superuser (FK triggers off, so no parent graph is needed). */
  async function connection(nextSyncAtSql = 'NULL'): Promise<string> {
    const id = randomUUID();
    ids.push(id);
    await admin.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
      await tx.$executeRawUnsafe(
        `INSERT INTO calendar_connections (id, org_id, user_id, provider, display_name, external_account_id,
           access_token_enc, refresh_token_enc, token_key_id, next_sync_at, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'google', 'fixture', $4, 'v1.k.a.b', 'v1.k.a.b', 'k', ${nextSyncAtSql}, now())`,
        id,
        ORG,
        USER,
        `ext-${id}`,
      );
    });
    return id;
  }
  const nextSyncAt = async (id: string) =>
    (
      await admin.$queryRawUnsafe<{ n: Date | null; db_now: Date }[]>(
        `SELECT next_sync_at AS n, clock_timestamp() AS db_now FROM calendar_connections WHERE id = $1::uuid`,
        id,
      )
    )[0]!;
  const window = () => {
    const now = new Date();
    return {
      from: new Date(now.getTime() - 3_600_000),
      to: new Date(now.getTime() + 3_600_000),
      now,
    };
  };

  beforeAll(async () => {
    await app.$connect();
    await admin.$connect();
    // Real parent rows: calendar_events (written by the app role) has enforced FKs to the organization.
    await admin.organization.create({
      data: { id: ORG, name: 'lease fixture', slug: `lease-${ORG}` },
    });
    await admin.user.create({ data: { id: USER, email: `lease-${USER}@example.test` } });
  });
  afterAll(async () => {
    if (ids.length)
      await admin.$executeRawUnsafe(
        `DELETE FROM calendar_connections WHERE id = ANY($1::uuid[])`,
        ids,
      );
    await admin.$executeRawUnsafe(`DELETE FROM organizations WHERE id = $1::uuid`, ORG);
    await admin.$executeRawUnsafe(`DELETE FROM users WHERE id = $1::uuid`, USER);
    await app.$disconnect();
    await admin.$disconnect();
  });

  it('long sweep: a connection reached late still gets a full lease from the database clock', async () => {
    // Due since long before a (hypothetical) sweep that started 30 min ago.
    const id = await connection(`now() - interval '30 minutes'`);
    const claim = await repo.claimForSync(ORG, id, 600_000);
    expect(claim).not.toBeNull();
    const { n, db_now } = await nextSyncAt(id);
    expect(n!.getTime()).toBe(claim!.lease.getTime());
    const remaining = n!.getTime() - db_now.getTime();
    expect(remaining).toBeGreaterThan(590_000);
    expect(remaining).toBeLessThanOrEqual(600_000);
    // still held: a second sweep cannot take it
    await expect(repo.claimForSync(ORG, id, 600_000)).resolves.toBeNull();
  });

  it('concurrent claims: exactly one of several replicas wins', async () => {
    const id = await connection();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => repo.claimForSync(ORG, id, 600_000)),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('expired lease: re-claimed by another sweep, and the stale holder can no longer write', async () => {
    const id = await connection();
    const a = await repo.claimForSync(ORG, id, 200);
    expect(a).not.toBeNull();
    await expect(repo.claimForSync(ORG, id, 600_000)).resolves.toBeNull();
    await sleep(400); // holder A overruns its lease
    const b = await repo.claimForSync(ORG, id, 600_000);
    expect(b).not.toBeNull();
    expect(b!.lease.getTime()).toBeGreaterThan(a!.lease.getTime());

    const ev = {
      id: 'evt-stale',
      title: 'stale',
      startsAt: new Date().toISOString(),
      endsAt: new Date(Date.now() + 60_000).toISOString(),
      allDay: false,
      attendeeCount: 1,
      status: 'confirmed' as const,
    };
    const stale = await repo.applySync(ORG, {
      connectionId: id,
      ...window(),
      events: [ev],
      complete: true,
      nextSyncInMs: 60_000,
      lease: a!.lease,
    });
    expect(stale).toEqual({ upserted: 0, cancelled: 0, applied: false });
    await expect(
      repo.recordFailure(ORG, id, { syncFailures: 1, retryInMs: 60_000, lease: a!.lease }),
    ).resolves.toBe(false);
    const after = await nextSyncAt(id);
    expect(after.n!.getTime()).toBe(b!.lease.getTime()); // B's lease untouched
    const events = await admin.$queryRawUnsafe<{ c: bigint }[]>(
      `SELECT count(*) AS c FROM calendar_events WHERE connection_id = $1::uuid`,
      id,
    );
    expect(Number(events[0]!.c)).toBe(0);

    // The current holder writes, and next_sync_at comes from the database clock at commit.
    const ok = await repo.applySync(ORG, {
      connectionId: id,
      ...window(),
      events: [{ ...ev, id: 'evt-ok' }],
      complete: true,
      nextSyncInMs: 900_000,
      lease: b!.lease,
    });
    expect(ok).toMatchObject({ upserted: 1, applied: true });
    const done = await nextSyncAt(id);
    const delta = done.n!.getTime() - done.db_now.getTime();
    expect(delta).toBeGreaterThan(890_000);
    expect(delta).toBeLessThanOrEqual(900_000);
    // B's lease is gone with the write, so a late B failure write is refused too
    await expect(
      repo.recordFailure(ORG, id, { syncFailures: 1, retryInMs: 1_000, lease: b!.lease }),
    ).resolves.toBe(false);
  });

  it('recordFailure under a held lease backs off from the database clock', async () => {
    const id = await connection();
    const c = await repo.claimForSync(ORG, id, 600_000);
    await expect(
      repo.recordFailure(ORG, id, { syncFailures: 2, retryInMs: 120_000, lease: c!.lease }),
    ).resolves.toBe(true);
    const { n, db_now } = await nextSyncAt(id);
    const delta = n!.getTime() - db_now.getTime();
    expect(delta).toBeGreaterThan(110_000);
    expect(delta).toBeLessThanOrEqual(120_000);
  });
});
