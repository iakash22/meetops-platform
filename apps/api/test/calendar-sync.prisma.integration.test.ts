/**
 * P7 calendar background sync over live Postgres (forced RLS, meetops_app role, SECURITY DEFINER routing,
 * TokenCipher envelopes written by the API repository). Skipped unless TEST_DATABASE_URL (app role) and
 * TEST_OWNER_DATABASE_URL (migrator, to create orgs/users) are set.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  createCalendarSyncRepository,
  createPrismaClient,
  withOrganizationContext,
  type DatabaseClient,
} from '@meetops/database';
import { LocalKeyProvider, TokenCipher } from '@meetops/integrations';
import { PrismaCalendarConnections } from '../src/modules/calendar/prisma.repository.js';
import { selectCalendarSyncStore } from '../src/modules/calendar/index.js';

const url = process.env.TEST_DATABASE_URL;
const owner = process.env.TEST_OWNER_DATABASE_URL;

describe.skipIf(!url || !owner)('P7 calendar sync (live RLS)', { timeout: 60_000 }, () => {
  let db: DatabaseClient;
  const orgA = randomUUID();
  const orgB = randomUUID();
  const user = randomUUID();
  const other = randomUUID();
  const cipher = new TokenCipher(new LocalKeyProvider({ k1: randomBytes(32) }, 'k1'));
  const NOW = new Date('2026-11-01T00:00:00.000Z');
  const FROM = new Date('2026-10-31T00:00:00.000Z');
  const TO = new Date('2026-12-01T00:00:00.000Z');
  const ev = (id: string, startsAt: string, over: Record<string, unknown> = {}) => ({
    id,
    title: `t-${id}`,
    startsAt,
    endsAt: new Date(Date.parse(startsAt) + 1800e3).toISOString(),
    allDay: false,
    attendeeCount: 1,
    status: 'confirmed' as const,
    ...over,
  });

  beforeAll(async () => {
    const o = createPrismaClient({ databaseUrl: owner! });
    for (const id of [orgA, orgB])
      await o.organization.create({ data: { id, name: 'Sync', slug: `sync-${id.slice(0, 8)}` } });
    for (const id of [user, other])
      await o.user.create({
        data: { id, email: `sync-${id.slice(0, 8)}@example.com`, name: 'Sync' },
      });
    await o.$disconnect();
    db = createPrismaClient({ databaseUrl: url! });
  });
  afterAll(async () => db?.$disconnect());

  it('routes due connections across tenants, decrypts API-written tokens, upserts, cancels and serves reads', async () => {
    const conns = new PrismaCalendarConnections(db, cipher);
    const sync = createCalendarSyncRepository({ client: db, cipher });
    const a = await conns.upsert(orgA, {
      userId: user,
      provider: 'google',
      displayName: 'Me',
      externalAccountId: `me-${orgA.slice(0, 8)}@example.test`,
      accessToken: 'plain-access',
      refreshToken: 'plain-refresh',
      accessTokenExpiresAt: new Date(NOW.getTime() + 3600e3),
    });

    // Cross-tenant routing via the definer function (ids only), never-synced first.
    const due = await sync.listDueForSync(NOW, 500);
    expect(due).toContainEqual({
      organizationId: orgA,
      id: a.id,
      userId: user,
      provider: 'google',
    });

    // Token envelopes written by the API repository decrypt with the same per-field AAD scheme.
    const s = await sync.readSecrets(orgA, a.id);
    expect(s).toMatchObject({
      userId: user,
      accessToken: 'plain-access',
      refreshToken: 'plain-refresh',
    });
    expect(await sync.readSecrets(orgB, a.id)).toBeNull();

    const first = await sync.applySync(orgA, {
      connectionId: a.id,
      from: FROM,
      to: TO,
      events: [
        ev('e1', '2026-11-02T09:00:00.000Z', {
          conferenceUrl: 'https://meet.google.com/abc-defg-hij',
        }),
        ev('e2', '2026-11-03T09:00:00.000Z', { conferenceUrl: 'http://insecure.example' }),
        ev('e3', '2026-11-04T09:00:00.000Z'),
      ],
      complete: true,
      now: NOW,
      nextSyncAt: new Date(NOW.getTime() + 900e3),
    });
    expect(first).toEqual({ upserted: 3, cancelled: 0, applied: true });
    // Not due again until next_sync_at.
    expect((await sync.listDueForSync(NOW, 500)).map((d) => d.id)).not.toContain(a.id);

    // e2 retitled, e3 gone from the (complete) provider list -> soft-cancelled; idempotent upsert.
    const second = await sync.applySync(orgA, {
      connectionId: a.id,
      from: FROM,
      to: TO,
      events: [
        ev('e1', '2026-11-02T09:00:00.000Z'),
        ev('e2', '2026-11-03T09:00:00.000Z', { title: 'renamed' }),
      ],
      complete: true,
      now: NOW,
      nextSyncAt: new Date(NOW.getTime() + 900e3),
    });
    expect(second).toEqual({ upserted: 2, cancelled: 1, applied: true });
    // A truncated list never cancels.
    const third = await sync.applySync(orgA, {
      connectionId: a.id,
      from: FROM,
      to: TO,
      events: [ev('e1', '2026-11-02T09:00:00.000Z')],
      complete: false,
      now: NOW,
      nextSyncAt: new Date(NOW.getTime() + 900e3),
    });
    expect(third.cancelled).toBe(0);

    const store = selectCalendarSyncStore({ db } as never, { CALENDAR_SYNC_ENABLED: 'true' })!;
    const cov = await store.coverage(orgA, user, a.id);
    expect(cov).toEqual({ from: FROM, to: TO, lastSyncedAt: NOW });
    const list = await store.listEvents(orgA, user, a.id, FROM, TO);
    expect(list.map((e) => [e.id, e.title])).toEqual([
      ['e1', 't-e1'],
      ['e2', 'renamed'],
    ]);
    expect(list[1]!.conferenceUrl).toBeUndefined(); // non-https dropped

    // Isolation: other org, other user and no-context reads see nothing.
    expect(await store.coverage(orgB, user, a.id)).toBeNull();
    expect(await store.coverage(orgA, other, a.id)).toBeNull();
    expect(await store.listEvents(orgB, user, a.id, FROM, TO)).toEqual([]);
    expect(await store.listEvents(orgA, other, a.id, FROM, TO)).toEqual([]);
    const raw = await db.$queryRaw<
      { n: bigint }[]
    >`SELECT count(*)::bigint AS n FROM calendar_events`;
    expect(Number(raw[0]!.n)).toBe(0);

    // The app role cannot DELETE synced events (soft-cancel only).
    await expect(
      withOrganizationContext(orgA, (tx) => tx.$executeRaw`DELETE FROM calendar_events`, {
        client: db,
      }),
    ).rejects.toThrow();
  });

  it('backs off on failure, drops errored and revoked connections from the due list', async () => {
    const conns = new PrismaCalendarConnections(db, cipher);
    const sync = createCalendarSyncRepository({ client: db, cipher });
    const mk = (n: string) =>
      conns.upsert(orgB, {
        userId: user,
        provider: 'google',
        displayName: n,
        externalAccountId: `${n}-${orgB.slice(0, 8)}@example.test`,
        accessToken: 'plain-access',
        refreshToken: 'plain-refresh',
        accessTokenExpiresAt: new Date(NOW.getTime() + 3600e3),
      });
    const [b1, b2, b3] = [await mk('b1'), await mk('b2'), await mk('b3')];
    await sync.recordFailure(orgB, b1.id, {
      syncFailures: 2,
      nextSyncAt: new Date(NOW.getTime() + 3600e3),
    });
    await sync.markError(orgB, b2.id);
    expect(await conns.revoke(orgB, user, b3.id)).toBe(true);
    const ids = (await sync.listDueForSync(NOW, 500)).map((d) => d.id);
    for (const id of [b1.id, b2.id, b3.id]) expect(ids).not.toContain(id);
    expect(
      (await sync.listDueForSync(new Date(NOW.getTime() + 7200e3), 500)).map((d) => d.id),
    ).toContain(b1.id);
    expect((await sync.readSecrets(orgB, b1.id))?.syncFailures).toBe(2);
    expect(await sync.readSecrets(orgB, b2.id)).toBeNull();
    // A sync for a revoked connection is a no-op.
    expect(
      await sync.applySync(orgB, {
        connectionId: b3.id,
        from: FROM,
        to: TO,
        events: [ev('x', '2026-11-02T09:00:00.000Z')],
        complete: true,
        now: NOW,
        nextSyncAt: NOW,
      }),
    ).toEqual({ upserted: 0, cancelled: 0, applied: false });
  });
});
