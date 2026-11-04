/**
 * P7 calendar auto-link over live Postgres (forced RLS, meetops_app role). The worker's applySync `autoLink` stores a
 * link (source=auto) only for an unambiguous match, writes one audit event per link, is idempotent, never overwrites
 * a manual link, never recreates one a user removed (soft unlink tombstone), and cannot reach another tenant.
 * Skipped unless TEST_DATABASE_URL (app role) and TEST_OWNER_DATABASE_URL (migrator, to create orgs/users) are set.
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
import { PrismaCalendarEventLinks } from '../src/modules/calendar/links.repository.js';

const url = process.env.TEST_DATABASE_URL;
const owner = process.env.TEST_OWNER_DATABASE_URL;

describe.skipIf(!url || !owner)('P7 calendar auto-link (live RLS)', { timeout: 60_000 }, () => {
  let db: DatabaseClient;
  const orgA = randomUUID();
  const orgB = randomUUID();
  const user = randomUUID();
  const viewer = randomUUID();
  const cipher = new TokenCipher(new LocalKeyProvider({ k1: randomBytes(32) }, 'k1'));
  const NOW = new Date('2026-11-01T00:00:00.000Z');
  const FROM = new Date('2026-10-31T00:00:00.000Z');
  const TO = new Date('2026-12-01T00:00:00.000Z');
  const ev = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    title: `t-${id}`,
    startsAt: '2026-11-02T09:00:00.000Z',
    endsAt: '2026-11-02T09:30:00.000Z',
    allDay: false,
    attendeeCount: 1,
    status: 'confirmed' as const,
    ...over,
  });
  const meeting = (org: string, externalMeetingId: string, source: 'extension' | 'desktop') =>
    withOrganizationContext(
      org,
      (tx) =>
        tx.meeting.create({ data: { organizationId: org, title: 'm', source, externalMeetingId } }),
      { client: db },
    );

  beforeAll(async () => {
    const o = createPrismaClient({ databaseUrl: owner! });
    for (const id of [orgA, orgB])
      await o.organization.create({ data: { id, name: 'AL', slug: `al-${id.slice(0, 8)}` } });
    await o.user.create({ data: { id: user, email: `al-${user.slice(0, 8)}@example.com` } });
    await o.user.create({ data: { id: viewer, email: `al-${viewer.slice(0, 8)}@example.com` } });
    // #398: auto-link needs meeting-level access (live, non-viewer membership) for the acting user.
    await o.membership.create({ data: { organizationId: orgA, userId: user, role: 'member' } });
    await o.membership.create({ data: { organizationId: orgA, userId: viewer, role: 'viewer' } });
    await o.$disconnect();
    db = createPrismaClient({ databaseUrl: url! });
  });
  afterAll(async () => db?.$disconnect());

  it('links unambiguous matches once, audits each, and respects manual and removed links', async () => {
    const conns = new PrismaCalendarConnections(db, cipher);
    const sync = createCalendarSyncRepository({ client: db, cipher });
    const links = new PrismaCalendarEventLinks(db);
    const c = await conns.upsert(orgA, {
      userId: user,
      provider: 'google',
      displayName: 'Me',
      externalAccountId: `al-${orgA.slice(0, 8)}@example.test`,
      accessToken: 'plain-access',
      refreshToken: 'plain-refresh',
      accessTokenExpiresAt: new Date(NOW.getTime() + 3600e3),
    });
    const one = await meeting(orgA, 'meet.google.com/aaa-bbbb-ccc', 'extension');
    await meeting(orgA, 'meet.google.com/dup-dupe-dup', 'extension');
    await meeting(orgA, 'meet.google.com/dup-dupe-dup', 'desktop'); // ambiguous
    const manualTarget = await meeting(orgA, 'meet.google.com/man-uall-yyy', 'extension');
    const foreign = await meeting(orgB, 'meet.google.com/fff-gggg-hhh', 'extension');

    // A manual link and a user-removed link exist before the sweep.
    await links.upsert(orgA, user, {
      connectionId: c.id,
      eventId: 'manual',
      meetingId: manualTarget.id,
    });
    await links.upsert(orgA, user, { connectionId: c.id, eventId: 'removed', meetingId: one.id });
    expect(await links.remove(orgA, user, c.id, 'removed')).toBe(true);
    expect(await links.remove(orgA, user, c.id, 'removed')).toBe(false);

    const candidates = [
      { eventId: 'e-one', externalMeetingId: 'meet.google.com/aaa-bbbb-ccc' },
      { eventId: 'e-dup', externalMeetingId: 'meet.google.com/dup-dupe-dup' },
      { eventId: 'e-foreign', externalMeetingId: 'meet.google.com/fff-gggg-hhh' },
      { eventId: 'e-none', externalMeetingId: 'meet.google.com/nop-nope-nop' },
      { eventId: 'e-cancelled', externalMeetingId: 'meet.google.com/aaa-bbbb-ccc' },
      { eventId: 'manual', externalMeetingId: 'meet.google.com/aaa-bbbb-ccc' },
      { eventId: 'removed', externalMeetingId: 'meet.google.com/aaa-bbbb-ccc' },
      { eventId: 'not-in-sync', externalMeetingId: 'meet.google.com/aaa-bbbb-ccc' },
    ];
    const apply = () =>
      sync.applySync(orgA, {
        connectionId: c.id,
        from: FROM,
        to: TO,
        events: ['e-one', 'e-dup', 'e-foreign', 'e-none', 'manual', 'removed']
          .map((id) => ev(id))
          .concat([ev('e-cancelled', { status: 'cancelled' })]),
        complete: true,
        now: NOW,
        nextSyncInMs: 60_000,
        autoLink: candidates,
      });

    expect(await apply()).toMatchObject({ applied: true, autoLinked: 1 });
    expect(await apply()).toMatchObject({ applied: true, autoLinked: 0 }); // idempotent

    const rows = await withOrganizationContext(
      orgA,
      (tx) =>
        tx.calendarEventLink.findMany({
          where: { organizationId: orgA, connectionId: c.id },
          select: { providerEventId: true, meetingId: true, source: true, unlinkedAt: true },
          orderBy: { providerEventId: 'asc' },
        }),
      { client: db },
    );
    expect(
      rows.map((r) => [r.providerEventId, r.meetingId, r.source, r.unlinkedAt !== null]),
    ).toEqual([
      ['e-one', one.id, 'auto', false],
      ['manual', manualTarget.id, 'manual', false],
      ['removed', one.id, 'manual', true],
    ]);
    expect(rows.some((r) => r.meetingId === foreign.id)).toBe(false);

    // Readers ignore the tombstone; a manual re-link revives it.
    const visible = await links.listForUser(orgA, user, [c.id]);
    expect(visible.map((l) => l.eventId).sort()).toEqual(['e-one', 'manual']);
    await links.upsert(orgA, user, { connectionId: c.id, eventId: 'removed', meetingId: one.id });
    expect((await links.listForUser(orgA, user, [c.id])).map((l) => l.eventId).sort()).toEqual([
      'e-one',
      'manual',
      'removed',
    ]);

    // Exactly one audit event for the auto link, system actor, no event content.
    const audits = await withOrganizationContext(
      orgA,
      (tx) =>
        tx.$queryRaw<
          { actor_type: string; actor_id: string | null; target_id: string; metadata: unknown }[]
        >`
          SELECT actor_type, actor_id, target_id, metadata FROM audit_events
           WHERE org_id = ${orgA}::uuid AND action = 'calendar.link'`,
      { client: db },
    ).catch(() => null);
    // audit_events may be insert-only for the app role; fall back to the owner connection.
    const rowsA =
      audits ??
      (await (async () => {
        const o = createPrismaClient({ databaseUrl: owner! });
        try {
          return await o.$queryRaw<
            { actor_type: string; actor_id: string | null; target_id: string; metadata: unknown }[]
          >`SELECT actor_type, actor_id, target_id, metadata FROM audit_events
             WHERE org_id = ${orgA}::uuid AND action = 'calendar.link'`;
        } finally {
          await o.$disconnect();
        }
      })());
    expect(rowsA).toEqual([
      {
        actor_type: 'system',
        actor_id: null,
        target_id: c.id,
        metadata: { meetingId: one.id, source: 'auto' },
      },
    ]);

    // Tenant B sees nothing of tenant A's links (forced RLS).
    const leaked = await withOrganizationContext(
      orgB,
      (tx) => tx.calendarEventLink.count({ where: { connectionId: c.id } }),
      { client: db },
    );
    expect(leaked).toBe(0);
  });
  it('#398: links every unique match with no row cap, even next to a heavily duplicated id', async () => {
    const conns = new PrismaCalendarConnections(db, cipher);
    const sync = createCalendarSyncRepository({ client: db, cipher });
    const c = await conns.upsert(orgA, {
      userId: user,
      provider: 'google',
      displayName: 'Me',
      externalAccountId: `cap-${orgA.slice(0, 8)}@example.test`,
      accessToken: 'plain-access',
      refreshToken: 'plain-refresh',
      accessTokenExpiresAt: new Date(NOW.getTime() + 3600e3),
    });
    // Four ids each shared by one live meeting per source (5 rows each, ambiguous): 21 candidate rows for 5 ids
    // exceeds the old `take: ext.length * 4` page (20), which could drop the one unique match.
    const busy = ['bua', 'bub', 'buc', 'bud'].map((p) => `meet.google.com/${p}-yyyy-bus`);
    for (const x of busy)
      for (const source of ['upload', 'extension', 'desktop', 'bot', 'mobile'] as const)
        await withOrganizationContext(
          orgA,
          (tx) =>
            tx.meeting.create({
              data: { organizationId: orgA, title: 'm', source, externalMeetingId: x },
            }),
          { client: db },
        );
    const solo = await meeting(orgA, 'meet.google.com/sol-oooo-sol', 'extension');
    const r = await sync.applySync(orgA, {
      connectionId: c.id,
      from: FROM,
      to: TO,
      events: [...busy.map((_, i) => ev(`c-busy-${i}`)), ev('c-solo')],
      complete: true,
      now: NOW,
      nextSyncInMs: 60_000,
      autoLink: [
        ...busy.map((x, i) => ({ eventId: `c-busy-${i}`, externalMeetingId: x })),
        { eventId: 'c-solo', externalMeetingId: 'meet.google.com/sol-oooo-sol' },
      ],
    });
    expect(r).toMatchObject({ applied: true, autoLinked: 1 });
    const rows = await withOrganizationContext(
      orgA,
      (tx) =>
        tx.calendarEventLink.findMany({
          where: { organizationId: orgA, connectionId: c.id },
          select: { providerEventId: true, meetingId: true },
        }),
      { client: db },
    );
    expect(rows).toEqual([{ providerEventId: 'c-solo', meetingId: solo.id }]);
  });

  it('#398: denied: no auto links for a user without meeting-level access (viewer)', async () => {
    const conns = new PrismaCalendarConnections(db, cipher);
    const sync = createCalendarSyncRepository({ client: db, cipher });
    const c = await conns.upsert(orgA, {
      userId: viewer,
      provider: 'google',
      displayName: 'Viewer',
      externalAccountId: `v-${orgA.slice(0, 8)}@example.test`,
      accessToken: 'plain-access',
      refreshToken: 'plain-refresh',
      accessTokenExpiresAt: new Date(NOW.getTime() + 3600e3),
    });
    await meeting(orgA, 'meet.google.com/vvv-wwww-xxx', 'extension');
    const r = await sync.applySync(orgA, {
      connectionId: c.id,
      from: FROM,
      to: TO,
      events: [ev('v-one')],
      complete: true,
      now: NOW,
      nextSyncInMs: 60_000,
      autoLink: [{ eventId: 'v-one', externalMeetingId: 'meet.google.com/vvv-wwww-xxx' }],
    });
    expect(r).toMatchObject({ applied: true, autoLinked: 0 });
    const n = await withOrganizationContext(
      orgA,
      (tx) => tx.calendarEventLink.count({ where: { connectionId: c.id } }),
      { client: db },
    );
    expect(n).toBe(0);
  });
});
