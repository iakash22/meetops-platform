/**
 * Live RLS checks XT-26..XT-29 (docs/12-security/test-cases.md).
 * Skipped unless RLS_TEST_APP_URL (connects as meetops_app) and RLS_TEST_OWNER_URL are set
 * against a migrated pgvector Postgres.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import {
  TENANT_TABLES,
  runWithOrgContext,
  runWithOrganizationContext,
  runWithUserContext,
} from '../src/tenant.js';

const APP_URL = process.env.RLS_TEST_APP_URL;
const OWNER_URL = process.env.RLS_TEST_OWNER_URL;
const ADMIN_URL = process.env.RLS_TEST_ADMIN_URL;

describe.skipIf(!APP_URL || !OWNER_URL)('RLS live (XT-26..XT-29)', () => {
  const app = new PrismaClient({ datasources: { db: { url: APP_URL ?? '' } } });
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL ?? '' } } });
  const orgA = randomUUID();
  const orgB = randomUUID();

  it('setup two orgs with a project each', async () => {
    await owner.organization.createMany({
      data: [
        { id: orgA, name: 'A', slug: `a-${orgA}` },
        { id: orgB, name: 'B', slug: `b-${orgB}` },
      ],
    });
    for (const organizationId of [orgA, orgB]) {
      await runWithOrganizationContext(owner, organizationId, (tx) =>
        tx.project.create({ data: { organizationId, name: 'P', key: 'P' } }),
      );
    }
  });

  it('XT-26: no context => 0 rows', async () => {
    expect(await app.project.count()).toBe(0);
  });

  it('XT-27: context A cannot insert org B rows', async () => {
    await expect(
      runWithOrganizationContext(app, orgA, (tx) =>
        tx.project.create({ data: { organizationId: orgB, name: 'x', key: 'X' } }),
      ),
    ).rejects.toThrow();
    expect(await runWithOrganizationContext(app, orgA, (tx) => tx.project.count())).toBe(1);
  });

  it('XT-28: context does not leak to the next transaction', async () => {
    await runWithOrganizationContext(app, orgA, (tx) => tx.project.count());
    const leaked = await app.$transaction((tx) => tx.project.count());
    expect(leaked).toBe(0);
  });

  it('XT-29: every org_id table has RLS enabled + forced + policy', async () => {
    const rows = await owner.$queryRaw<
      { relname: string; rls: boolean; forced: boolean; policies: bigint }[]
    >`
      SELECT c.relname, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             (SELECT count(*) FROM pg_policies p WHERE p.tablename = c.relname) AS policies
      FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id'
      WHERE c.relkind = 'r' AND c.relnamespace = current_schema()::regnamespace`;
    expect(rows.map((r) => r.relname).sort()).toEqual([...TENANT_TABLES].sort());
    for (const r of rows) {
      expect(r.rls && r.forced && r.policies > 0n, r.relname).toBe(true);
    }
    await app.$disconnect();
    await owner.$disconnect();
  });
});

describe.skipIf(!APP_URL || !OWNER_URL)('invitation definer functions (live)', () => {
  const app = new PrismaClient({ datasources: { db: { url: APP_URL ?? '' } } });
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL ?? '' } } });
  const organizationId = randomUUID();
  const userId = randomUUID();
  const otherUserId = randomUUID();
  const tokenHash = `hash-${randomUUID()}`;
  const expiredHash = `hash-${randomUUID()}`;

  it('setup', async () => {
    await owner.organization.create({
      data: { id: organizationId, name: 'Inv', slug: `inv-${organizationId}` },
    });
    await owner.user.createMany({
      data: [
        { id: userId, email: `invitee-${organizationId}@example.test` },
        { id: otherUserId, email: `other-${organizationId}@example.test` },
      ],
    });
    await runWithOrganizationContext(owner, organizationId, (tx) =>
      tx.invitation.createMany({
        data: [
          {
            organizationId,
            email: `Invitee-${organizationId}@example.test`,
            role: 'member',
            tokenHash,
            expiresAt: new Date(Date.now() + 3_600_000),
          },
          {
            organizationId,
            email: `invitee-${organizationId}@example.test`,
            tokenHash: expiredHash,
            expiresAt: new Date(Date.now() - 1000),
          },
        ],
      }),
    );
  });

  it('app cannot read invitations directly without org context', async () => {
    expect(await app.invitation.count()).toBe(0);
  });

  it('lookup by token hash returns minimal fields across RLS', async () => {
    const rows = await app.$queryRaw<
      Record<string, unknown>[]
    >`SELECT * FROM lookup_invitation_by_token_hash(${tokenHash})`;
    expect(rows).toHaveLength(1);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      'email',
      'expires_at',
      'id',
      'org_id',
      'role',
    ]);
    expect(rows[0]?.org_id).toBe(organizationId);
    const none = await app.$queryRaw<
      unknown[]
    >`SELECT * FROM lookup_invitation_by_token_hash(${'nope'})`;
    expect(none).toHaveLength(0);
    // expired invitations are not returned (security review 1)
    expect(
      await app.$queryRaw<unknown[]>`SELECT * FROM lookup_invitation_by_token_hash(${expiredHash})`,
    ).toHaveLength(0);
  });

  it('accept rejects wrong user email and expired tokens', async () => {
    await expect(
      app.$queryRaw`SELECT * FROM accept_invitation(${tokenHash}, ${otherUserId}::uuid)`,
    ).rejects.toThrow(/invitation_invalid/);
    await expect(
      app.$queryRaw`SELECT * FROM accept_invitation(${expiredHash}, ${userId}::uuid)`,
    ).rejects.toThrow(/invitation_invalid/);
  });

  it('accept creates membership, marks accepted, audits; second accept fails', async () => {
    const rows = await app.$queryRaw<{ membership_id: string; org_id: string; role: string }[]>`
      SELECT * FROM accept_invitation(${tokenHash}, ${userId}::uuid)`;
    expect(rows[0]?.org_id).toBe(organizationId);
    expect(rows[0]?.role).toBe('member');
    const state = await runWithOrganizationContext(app, organizationId, async (tx) => ({
      m: await tx.membership.count({ where: { userId } }),
      inv: await tx.invitation.findFirst({ where: { tokenHash } }),
      audit: await tx.auditEvent.count({ where: { action: 'invitation.accepted' } }),
    }));
    expect(state).toMatchObject({ m: 1, audit: 1 });
    expect(state.inv?.status).toBe('accepted');
    await expect(
      app.$queryRaw`SELECT * FROM accept_invitation(${tokenHash}, ${userId}::uuid)`,
    ).rejects.toThrow(/invitation_invalid/);
    // accepted invitations are not returned by lookup (security review 1)
    expect(
      await app.$queryRaw<unknown[]>`SELECT * FROM lookup_invitation_by_token_hash(${tokenHash})`,
    ).toHaveLength(0);
  });

  it('lookup hides revoked and soft-deleted invitations', async () => {
    const revokedHash = `hash-${randomUUID()}`;
    const deletedHash = `hash-${randomUUID()}`;
    const future = new Date(Date.now() + 3_600_000);
    await runWithOrganizationContext(owner, organizationId, (tx) =>
      tx.invitation.createMany({
        data: [
          {
            organizationId,
            email: 'r@example.test',
            tokenHash: revokedHash,
            expiresAt: future,
            revokedAt: new Date(),
          },
          {
            organizationId,
            email: 'd@example.test',
            tokenHash: deletedHash,
            expiresAt: future,
            deletedAt: new Date(),
          },
        ],
      }),
    );
    for (const h of [revokedHash, deletedHash]) {
      expect(
        await app.$queryRaw<unknown[]>`SELECT * FROM lookup_invitation_by_token_hash(${h})`,
      ).toHaveLength(0);
    }
  });

  it('B1: the sole owner accepting a viewer invite is refused; org keeps 1 owner; invite stays pending', async () => {
    const soleOrg = randomUUID();
    const ownerId = randomUUID();
    const email = `sole-${ownerId}@example.test`;
    const hash = `hash-${randomUUID()}`;
    await owner.organization.create({
      data: { id: soleOrg, name: 'Sole', slug: `sole-${soleOrg}` },
    });
    await owner.user.create({ data: { id: ownerId, email } });
    await runWithOrganizationContext(owner, soleOrg, async (tx) => {
      await tx.membership.create({
        data: { organizationId: soleOrg, userId: ownerId, role: 'owner' },
      });
      await tx.invitation.create({
        data: {
          organizationId: soleOrg,
          email,
          role: 'viewer',
          tokenHash: hash,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
    });
    await expect(
      app.$queryRaw`SELECT * FROM accept_invitation(${hash}, ${ownerId}::uuid)`,
    ).rejects.toThrow(/already_member/);
    const after = await runWithOrganizationContext(app, soleOrg, async (tx) => ({
      owners: await tx.membership.count({ where: { role: 'owner', deletedAt: null } }),
      role: (await tx.membership.findFirst({ where: { userId: ownerId } }))?.role,
      inv: (await tx.invitation.findFirst({ where: { tokenHash: hash } }))?.status,
      audits: await tx.auditEvent.count({ where: { action: 'invitation.accepted' } }),
    }));
    expect(after).toEqual({ owners: 1, role: 'owner', inv: 'pending', audits: 0 });
  });

  it('B1: an active member accepting any invite is refused and keeps their role', async () => {
    const memberId = randomUUID();
    const email = `active-${memberId}@example.test`;
    const hash = `hash-${randomUUID()}`;
    await owner.user.create({ data: { id: memberId, email } });
    await runWithOrganizationContext(owner, organizationId, async (tx) => {
      await tx.membership.create({ data: { organizationId, userId: memberId, role: 'member' } });
      await tx.invitation.create({
        data: {
          organizationId,
          email,
          role: 'admin',
          tokenHash: hash,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
    });
    await expect(
      app.$queryRaw`SELECT * FROM accept_invitation(${hash}, ${memberId}::uuid)`,
    ).rejects.toThrow(/already_member/);
    const m = await runWithOrganizationContext(app, organizationId, (tx) =>
      tx.membership.findFirst({ where: { userId: memberId } }),
    );
    expect(m?.role).toBe('member');
  });

  it('BLOCKER: a removed owner re-invited as viewer comes back as viewer, not owner', async () => {
    const exOwner = randomUUID();
    const email = `ex-owner-${exOwner}@example.test`;
    const reinvite = `hash-${randomUUID()}`;
    await owner.user.create({ data: { id: exOwner, email } });
    await runWithOrganizationContext(owner, organizationId, async (tx) => {
      await tx.membership.create({
        data: { organizationId, userId: exOwner, role: 'owner', deletedAt: new Date() },
      });
      await tx.invitation.create({
        data: {
          organizationId,
          email,
          role: 'viewer',
          tokenHash: reinvite,
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });
    });
    const rows = await app.$queryRaw<{ role: string }[]>`
      SELECT * FROM accept_invitation(${reinvite}, ${exOwner}::uuid)`;
    expect(rows[0]?.role).toBe('viewer');
    const m = await runWithOrganizationContext(app, organizationId, (tx) =>
      tx.membership.findFirst({ where: { userId: exOwner } }),
    );
    expect(m).toMatchObject({ role: 'viewer', deletedAt: null });
  });

  it('PUBLIC cannot execute the functions', async () => {
    const rows = await owner.$queryRaw<{ fn: string; pub: boolean; app: boolean }[]>`
      SELECT p.proname AS fn,
             has_function_privilege('public', p.oid, 'EXECUTE') AS pub,
             has_function_privilege('meetops_app', p.oid, 'EXECUTE') AS app
      FROM pg_proc p WHERE p.proname IN ('lookup_invitation_by_token_hash', 'accept_invitation')`;
    expect(rows).toHaveLength(2);
    for (const r of rows) expect([r.fn, r.pub, r.app]).toEqual([r.fn, false, true]);
    await app.$disconnect();
    await owner.$disconnect();
  });
});

const RELAY_URL = process.env.RLS_TEST_RELAY_URL;

describe.skipIf(!RELAY_URL || !OWNER_URL)('outbox relay role (live)', () => {
  const relay = new PrismaClient({ datasources: { db: { url: RELAY_URL ?? '' } } });
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL ?? '' } } });
  const orgs = [randomUUID(), randomUUID()];

  it('setup one pending event per org', async () => {
    for (const id of orgs) {
      await owner.organization.create({ data: { id, name: 'R', slug: `r-${id}` } });
      await runWithOrganizationContext(owner, id, (tx) =>
        tx.outboxEvent.create({
          data: {
            organizationId: id,
            aggregateType: 'meeting',
            aggregateId: randomUUID(),
            eventType: 'meeting.created',
            payload: {},
          },
        }),
      );
    }
  });

  it('claims due pending events across orgs via the definer function and completes them', async () => {
    const claimed = await relay.$queryRaw<
      { id: string; org_id: string; attempts: number }[]
    >`SELECT * FROM relay_claim_outbox_events(500, ${['meeting.created']}::text[])`;
    const mine = claimed.filter((e) => (orgs as string[]).includes(e.org_id));
    expect(mine.map((e) => e.org_id).sort()).toEqual([...orgs].sort());
    expect(Object.keys(claimed[0] ?? {}).sort()).toEqual(
      [
        'aggregate_id',
        'aggregate_type',
        'attempts',
        'event_type',
        'id',
        'org_id',
        'payload',
      ].sort(),
    );
    // claimed rows are not handed out twice
    const again = await relay.$queryRaw<
      { id: string }[]
    >`SELECT * FROM relay_claim_outbox_events(500, ${['meeting.created']}::text[])`;
    expect(again.filter((e) => mine.some((m) => m.id === e.id))).toHaveLength(0);
    const [first, second] = mine;
    expect(
      await relay.$queryRaw<
        { ok: boolean }[]
      >`SELECT relay_complete_outbox_event(${first?.id}::uuid, true) AS ok`,
    ).toEqual([{ ok: true }]);
    expect(
      await relay.$queryRaw<
        { ok: boolean }[]
      >`SELECT relay_complete_outbox_event(${second?.id}::uuid, false, 'boom', now() + interval '1 minute') AS ok`,
    ).toEqual([{ ok: true }]);
    // completing twice is a no-op (only processing rows change)
    expect(
      await relay.$queryRaw<
        { ok: boolean }[]
      >`SELECT relay_complete_outbox_event(${first?.id}::uuid, true) AS ok`,
    ).toEqual([{ ok: false }]);
    const states = await owner.$queryRaw<{ status: string; last_error: string | null }[]>`
      SELECT status::text, last_error FROM outbox_events WHERE org_id = ANY(${orgs}::uuid[]) ORDER BY status`;
    expect(states.map((r) => r.status).sort()).toEqual(['pending', 'published']);
  });

  it('claim by event type leaves other kinds pending and untouched', async () => {
    const org = orgs[0]!;
    const mk = (eventType: string) =>
      runWithOrganizationContext(owner, org, (tx) =>
        tx.outboxEvent.create({
          data: {
            organizationId: org,
            aggregateType: 'meeting',
            aggregateId: randomUUID(),
            eventType,
            payload: {},
          },
        }),
      );
    const want = await mk('meeting.summary_ready');
    const other = await mk('auth.new_location_signin');
    const claimed = await relay.$queryRaw<
      { id: string; event_type: string }[]
    >`SELECT * FROM relay_claim_outbox_events(500, ${['meeting.summary_ready']}::text[])`;
    expect(claimed.some((e) => e.id === want.id)).toBe(true);
    expect(claimed.every((e) => e.event_type === 'meeting.summary_ready')).toBe(true);
    const [o] = await owner.$queryRaw<{ status: string; attempts: number }[]>`
      SELECT status::text, attempts FROM outbox_events WHERE id = ${other.id}::uuid`;
    expect(o).toEqual({ status: 'pending', attempts: 0 });
    expect(
      await relay.$queryRaw<
        { id: string }[]
      >`SELECT * FROM relay_claim_outbox_events(500, ${[] as string[]}::text[])`,
    ).toEqual([]);
  });

  it('cannot call the claim-all-kinds overload (20261028030000)', async () => {
    await expect(relay.$queryRaw`SELECT * FROM relay_claim_outbox_events(500)`).rejects.toThrow(
      /permission denied/,
    );
  });

  it('has no table privileges at all and no BYPASSRLS', async () => {
    await expect(relay.outboxEvent.findMany()).rejects.toThrow(/permission denied/);
    await expect(relay.meeting.count()).rejects.toThrow(/permission denied/);
    await expect(relay.organization.count()).rejects.toThrow(/permission denied/);
    await expect(
      relay.$executeRaw`UPDATE outbox_events SET status = 'published' WHERE false`,
    ).rejects.toThrow(/permission denied/);
    // Role name from the relay connection itself, so this also holds under per-run role names.
    const attrs = await relay.$queryRaw<{ bypass: boolean }[]>`
      SELECT rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`;
    expect(attrs).toEqual([{ bypass: false }]);
    await relay.$disconnect();
    await owner.$disconnect();
  });
});

describe.skipIf(!APP_URL || !OWNER_URL)('backend feedback (live)', () => {
  const app = new PrismaClient({ datasources: { db: { url: APP_URL ?? '' } } });
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL ?? '' } } });
  const orgA = randomUUID();
  const orgB = randomUUID();
  const userId = randomUUID();

  it('setup: user member of two orgs', async () => {
    await owner.user.create({ data: { id: userId, email: `multi-${userId}@example.test` } });
    for (const id of [orgA, orgB]) {
      await owner.organization.create({
        data: { id, name: 'U', slug: `u-${id}`, createdById: userId },
      });
      await runWithOrganizationContext(owner, id, (tx) =>
        tx.membership.create({ data: { organizationId: id, userId, role: 'admin' } }),
      );
    }
  });

  it('withUserContext lists own memberships across orgs; nothing else is visible', async () => {
    const rows = await runWithUserContext(app, userId, (tx) =>
      tx.membership.findMany({ where: { userId } }),
    );
    expect(rows.map((r) => r.organizationId).sort()).toEqual([orgA, orgB].sort());
    expect(await runWithUserContext(app, userId, (tx) => tx.project.count())).toBe(0);
    expect(await app.membership.count({ where: { userId } })).toBe(0);
  });

  it('global audit events (NULL org) only via record_global_auth_event; org events readable only in-org', async () => {
    const action = 'auth.login_failed';
    const target = `user-${randomUUID()}`;
    // direct org-NULL inserts are refused for the app (security review 2)
    await expect(
      app.auditEvent.createMany({
        data: [{ action, targetType: 'user', targetId: target, metadata: {} }],
      }),
    ).rejects.toThrow(/row-level security/);
    const [ok] = await app.$queryRaw<{ id: string }[]>`
      SELECT record_global_auth_event(${action}, NULL, 'user', ${target}, '{"reason":"bad_password"}'::jsonb, '127.0.0.1', 'vitest') AS id`;
    expect(ok?.id).toMatch(/^[0-9a-f-]{36}$/);
    await expect(
      app.$queryRaw`SELECT record_global_auth_event('org.deleted', NULL, 'user', 'x')`,
    ).rejects.toThrow(/audit_action_not_allowed/);
    await expect(
      app.$queryRaw`SELECT record_global_auth_event('auth.logout', NULL, 'project', 'x')`,
    ).rejects.toThrow(/audit_target_not_allowed/);
    expect(await app.auditEvent.count({ where: { targetId: target } })).toBe(0);
    expect(
      await runWithOrganizationContext(app, orgA, (tx) =>
        tx.auditEvent.count({ where: { targetId: target } }),
      ),
    ).toBe(0);
    // org-NULL rows are invisible under RLS even to the owner; check with the admin (superuser) role.
    if (ADMIN_URL) {
      const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL } } });
      const stored = await admin.$queryRaw<{ org_id: string | null; actor_type: string }[]>`
        SELECT org_id, actor_type FROM audit_events WHERE target_id = ${target}`;
      expect(stored).toEqual([{ org_id: null, actor_type: 'anonymous' }]);
      await admin.$disconnect();
    }
    const orgAction = `org.updated.${randomUUID()}`;
    await runWithOrganizationContext(app, orgA, (tx) =>
      tx.auditEvent.create({
        data: { organizationId: orgA, action: orgAction, targetType: 'org' },
      }),
    );
    expect(
      await runWithOrganizationContext(app, orgA, (tx) =>
        tx.auditEvent.count({ where: { action: orgAction } }),
      ),
    ).toBe(1);
    expect(
      await runWithOrganizationContext(app, orgB, (tx) =>
        tx.auditEvent.count({ where: { action: orgAction } }),
      ),
    ).toBe(0);
    await expect(
      runWithOrganizationContext(app, orgA, (tx) =>
        tx.auditEvent.create({ data: { organizationId: orgB, action: 'x', targetType: 'org' } }),
      ),
    ).rejects.toThrow();
    await expect(app.$executeRaw`UPDATE audit_events SET action = 'x' WHERE false`).rejects.toThrow(
      /permission denied/,
    );
  });

  it('email_verifications / password_resets usable by app without org context', async () => {
    const th = `ev-${randomUUID()}`;
    await app.emailVerification.create({
      data: {
        userId,
        email: `multi-${userId}@example.test`,
        tokenHash: th,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    expect((await app.emailVerification.findUnique({ where: { tokenHash: th } }))?.userId).toBe(
      userId,
    );
    const pr = await app.passwordReset.create({
      data: { userId, tokenHash: `pr-${randomUUID()}`, expiresAt: new Date(Date.now() + 60_000) },
    });
    await app.passwordReset.update({ where: { id: pr.id }, data: { usedAt: new Date() } });
    await expect(
      app.emailVerification.create({
        data: { userId, email: 'x', tokenHash: th, expiresAt: new Date() },
      }),
    ).rejects.toThrow();
    await app.$disconnect();
    await owner.$disconnect();
  });
});

describe.skipIf(!APP_URL || !OWNER_URL)('worker media ids and recording sessions (live)', () => {
  const app = new PrismaClient({ datasources: { db: { url: APP_URL ?? '' } } });
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL ?? '' } } });
  const organizationId = randomUUID();
  const otherOrg = randomUUID();
  const meetingId = randomUUID();
  const rawId = randomUUID();
  const recordingId = randomUUID();
  const base = `org/${organizationId}/meetings/${meetingId}`;

  it('setup org and meeting', async () => {
    await owner.organization.createMany({
      data: [
        { id: organizationId, name: 'M', slug: `m-${organizationId}` },
        { id: otherOrg, name: 'O', slug: `o-${otherOrg}` },
      ],
    });
    await runWithOrganizationContext(app, organizationId, (tx) =>
      tx.meeting.create({ data: { id: meetingId, organizationId, title: 'Media' } }),
    );
  });

  it('stores recording, normalized and chunk file_objects with the worker UUIDv5 ids (idempotent retry)', async () => {
    const { normalizedFileObjectId, chunkFileObjectId } = await import('./media-ids.js');
    const normId = normalizedFileObjectId(recordingId);
    const chunkIds = [0, 1, 2].map((i) => chunkFileObjectId(recordingId, i));
    const write = () =>
      runWithOrganizationContext(app, organizationId, async (tx) => {
        await tx.fileObject.upsert({
          where: { id: rawId },
          update: {},
          create: {
            id: rawId,
            organizationId,
            meetingId,
            kind: 'raw',
            bucket: 'b',
            key: `${base}/recordings/${recordingId}.webm`,
            mimeType: 'audio/webm',
          },
        });
        await tx.recording.upsert({
          where: { id: recordingId },
          update: {},
          create: {
            id: recordingId,
            organizationId,
            meetingId,
            fileObjectId: rawId,
            status: 'processing',
          },
        });
        await tx.fileObject.upsert({
          where: { id: normId },
          update: { sizeBytes: 100n },
          create: {
            id: normId,
            organizationId,
            meetingId,
            kind: 'normalized',
            parentObjectId: rawId,
            bucket: 'b',
            key: `${base}/processed/${recordingId}/normalized.wav`,
            mimeType: 'audio/wav',
            sizeBytes: 100n,
          },
        });
        for (const [i, id] of chunkIds.entries()) {
          await tx.fileObject.upsert({
            where: { id },
            update: {},
            create: {
              id,
              organizationId,
              meetingId,
              kind: 'chunk',
              parentObjectId: normId,
              chunkIndex: i,
              bucket: 'b',
              key: `${base}/processed/${recordingId}/chunks/${String(i).padStart(5, '0')}.wav`,
              mimeType: 'audio/wav',
            },
          });
        }
      });
    await write();
    await write(); // worker retry with the same deterministic ids
    const rows = await runWithOrganizationContext(app, organizationId, (tx) =>
      tx.fileObject.findMany({
        where: { id: { in: [normId, ...chunkIds] } },
        orderBy: { chunkIndex: 'asc' },
      }),
    );
    expect(rows.map((r) => r.id).sort()).toEqual([normId, ...chunkIds].sort());
    expect(rows.every((r) => r.id[14] === '5')).toBe(true);
    expect(rows.filter((r) => r.kind === 'chunk').map((r) => r.parentObjectId)).toEqual([
      normId,
      normId,
      normId,
    ]);
    // a duplicate chunk index under the same parent is refused
    await expect(
      runWithOrganizationContext(app, organizationId, (tx) =>
        tx.fileObject.create({
          data: {
            organizationId,
            kind: 'chunk',
            parentObjectId: normId,
            chunkIndex: 0,
            bucket: 'b',
            key: `${base}/dup.wav`,
            mimeType: 'audio/wav',
          },
        }),
      ),
    ).rejects.toThrow();
    expect(
      await runWithOrganizationContext(app, otherOrg, (tx) =>
        tx.fileObject.count({ where: { id: normId } }),
      ),
    ).toBe(0);
  });

  it('recording session lifecycle: chunks, duplicate seq refused, complete links the recording', async () => {
    const sessionId = randomUUID();
    await runWithOrganizationContext(app, organizationId, async (tx) => {
      await tx.recordingSession.create({
        data: {
          id: sessionId,
          organizationId,
          meetingId,
          mimeType: 'audio/webm',
          startedAt: new Date(),
        },
      });
      for (const seq of [0, 1]) {
        await tx.recordingSessionChunk.create({
          data: {
            organizationId,
            sessionId,
            seq,
            sizeBytes: 10,
            sha256: 'a'.repeat(64),
            storageKey: `${base}/sessions/${sessionId}/chunks/${String(seq).padStart(5, '0')}.part`,
          },
        });
      }
    });
    await expect(
      runWithOrganizationContext(app, organizationId, (tx) =>
        tx.recordingSessionChunk.create({
          data: { organizationId, sessionId, seq: 1, sizeBytes: 10, storageKey: `${base}/x.part` },
        }),
      ),
    ).rejects.toThrow();
    // completed requires a recording
    await expect(
      runWithOrganizationContext(app, organizationId, (tx) =>
        tx.recordingSession.update({ where: { id: sessionId }, data: { status: 'completed' } }),
      ),
    ).rejects.toThrow();
    const done = await runWithOrganizationContext(app, organizationId, (tx) =>
      tx.recordingSession.update({
        where: { id: sessionId },
        data: {
          status: 'completed',
          recordingId,
          chunkCount: 2,
          durationMs: 10_000,
          totalBytes: 20n,
          completedAt: new Date(),
        },
        include: { recording: true },
      }),
    );
    expect(done.recording?.status).toBe('processing');
    expect(
      await runWithOrganizationContext(app, otherOrg, (tx) =>
        tx.recordingSession.count({ where: { id: sessionId } }),
      ),
    ).toBe(0);
    expect(await app.recordingSessionChunk.count({ where: { sessionId } })).toBe(0);
  });

  it('abort needs a reason; chunk keys must sit under the org prefix', async () => {
    const sessionId = randomUUID();
    await runWithOrganizationContext(app, organizationId, (tx) =>
      tx.recordingSession.create({
        data: {
          id: sessionId,
          organizationId,
          meetingId,
          mimeType: 'audio/webm',
          startedAt: new Date(),
        },
      }),
    );
    await expect(
      runWithOrganizationContext(app, organizationId, (tx) =>
        tx.recordingSession.update({ where: { id: sessionId }, data: { status: 'aborted' } }),
      ),
    ).rejects.toThrow();
    await runWithOrganizationContext(app, organizationId, (tx) =>
      tx.recordingSession.update({
        where: { id: sessionId },
        data: { status: 'aborted', abortReason: 'tab_closed', abortedAt: new Date() },
      }),
    );
    await expect(
      runWithOrganizationContext(app, organizationId, (tx) =>
        tx.recordingSessionChunk.create({
          data: {
            organizationId,
            sessionId,
            seq: 0,
            sizeBytes: 1,
            storageKey: `org/${otherOrg}/x.part`,
          },
        }),
      ),
    ).rejects.toThrow();
    await app.$disconnect();
    await owner.$disconnect();
  });
});

describe.skipIf(!APP_URL)('DB-BUG-2: empty-string context fails closed (live)', () => {
  const app = new PrismaClient({ datasources: { db: { url: APP_URL ?? '' } } });

  it("session-level set_config('', false) returns 0 rows on every tenant table, no 22P02", async () => {
    await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', '', false)`;
      await tx.$executeRaw`SELECT set_config('app.current_user_id', '', false)`;
      for (const t of TENANT_TABLES) {
        const rows = await tx.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*) AS n FROM "${t}"`);
        expect(Number(rows[0]?.n), t).toBe(0);
      }
      // memberships self-read (app.current_user_id) is covered by the loop; audit_events read policy too.
    });
    await app.$disconnect();
  });
});

describe.skipIf(!APP_URL || !OWNER_URL)('transcripts.provider constraint (live)', () => {
  const app = new PrismaClient({ datasources: { db: { url: APP_URL ?? '' } } });
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL ?? '' } } });
  const organizationId = randomUUID();
  const meetingId = randomUUID();
  const recordingId = randomUUID();
  let rev = 0;
  const mk = (provider: string) =>
    runWithOrganizationContext(app, organizationId, (tx) =>
      tx.transcript.create({
        data: { organizationId, meetingId, recordingId, provider, revision: ++rev },
      }),
    );

  it('accepts real providers, rejects invalid and new unknown rows', async () => {
    await owner.organization.create({
      data: { id: organizationId, name: 'T', slug: `t-${organizationId}` },
    });
    await runWithOrganizationContext(app, organizationId, (tx) =>
      tx.meeting.create({ data: { id: meetingId, organizationId, title: 'T' } }),
    );
    await runWithOrganizationContext(app, organizationId, async (tx) => {
      const f = await tx.fileObject.create({
        data: {
          organizationId,
          meetingId,
          bucket: 'b',
          key: `org/${organizationId}/t.webm`,
          mimeType: 'audio/webm',
        },
      });
      await tx.recording.create({
        data: { id: recordingId, organizationId, meetingId, fileObjectId: f.id },
      });
    });
    // recording_id is required (contracts Transcript.recordingId)
    await expect(
      runWithOrganizationContext(
        app,
        organizationId,
        (tx) =>
          tx.$executeRaw`INSERT INTO transcripts (id, org_id, meeting_id, provider, revision, updated_at) VALUES (gen_random_uuid(), ${organizationId}::uuid, ${meetingId}::uuid, 'deepgram', 999999, now())`,
      ),
    ).rejects.toThrow(/23502|null value/);
    for (const p of ['assemblyai', 'faster-whisper', 'deepgram'])
      await expect(mk(p)).resolves.toMatchObject({ provider: p });
    await expect(mk('whisper-x')).rejects.toThrow(/transcripts_provider_check|check/i);
    await expect(mk('unknown')).rejects.toThrow(/reserved for backfilled legacy rows/);
    const t = await mk('deepgram');
    await expect(
      runWithOrganizationContext(app, organizationId, (tx) =>
        tx.transcript.update({ where: { id: t.id }, data: { provider: 'unknown' } }),
      ),
    ).rejects.toThrow(/reserved/);
    await app.$disconnect();
    await owner.$disconnect();
  });
});

describe.skipIf(!OWNER_URL || !ADMIN_URL)(
  'security review: audit append-only and forced RLS (live)',
  () => {
    const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL ?? '' } } });
    // Superuser bypasses RLS but NOT triggers: proves the trigger, not RLS, is what refuses changes.
    const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL ?? '' } } });
    const organizationId = randomUUID();
    const actorId = randomUUID();

    it('UPDATE, DELETE and TRUNCATE are refused even for a role that bypasses RLS', async () => {
      await owner.organization.create({
        data: { id: organizationId, name: 'A', slug: `aud-${organizationId}` },
      });
      await owner.user.create({ data: { id: actorId, email: `aud-${actorId}@example.test` } });
      await runWithOrganizationContext(owner, organizationId, (tx) =>
        tx.auditEvent.createMany({
          data: [{ organizationId, actorId, action: 'org.updated', targetType: 'org' }],
        }),
      );
      await expect(
        admin.$executeRaw`UPDATE audit_events SET action = 'tampered' WHERE org_id = ${organizationId}::uuid`,
      ).rejects.toThrow(/append-only/);
      await expect(
        admin.$executeRaw`DELETE FROM audit_events WHERE org_id = ${organizationId}::uuid`,
      ).rejects.toThrow(/append-only/);
      await expect(admin.$executeRaw`TRUNCATE audit_events`).rejects.toThrow(/append-only/);
      // the owner (RLS forced, no UPDATE policy) changes nothing either
      expect(
        await runWithOrganizationContext(
          owner,
          organizationId,
          (tx) =>
            tx.$executeRaw`UPDATE audit_events SET action = 'tampered' WHERE org_id = ${organizationId}::uuid`,
        ),
      ).toBe(0);
    });

    it('deleting a user nulls actor_id (the one allowed change); explicit maintenance opt-in works', async () => {
      await owner.user.delete({ where: { id: actorId } });
      const rows = await admin.$queryRaw<{ actor_id: string | null; action: string }[]>`
      SELECT actor_id, action FROM audit_events WHERE org_id = ${organizationId}::uuid`;
      expect(rows).toEqual([{ actor_id: null, action: 'org.updated' }]);
      // the hatch is keyed on session_user: a superuser session with the GUC is still refused
      await expect(
        admin.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('meetops.audit_maintenance', 'on', true)`;
          return tx.$executeRaw`UPDATE audit_events SET metadata = '{}'::jsonb WHERE org_id = ${organizationId}::uuid`;
        }),
      ).rejects.toThrow(/append-only/);
      // a maintenance migration (session meetops_migrator, own NO FORCE window, GUC on) may change rows
      class Rollback extends Error {}
      let n = -1;
      await expect(
        owner.$transaction(async (tx) => {
          await tx.$executeRaw`ALTER TABLE audit_events NO FORCE ROW LEVEL SECURITY`;
          await tx.$executeRaw`SELECT set_config('meetops.audit_maintenance', 'on', true)`;
          n =
            await tx.$executeRaw`UPDATE audit_events SET metadata = '{"redacted":true}'::jsonb WHERE org_id = ${organizationId}::uuid`;
          throw new Rollback('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(n).toBe(1);
      await admin.$disconnect();
    });

    it('a migrator-owned SECURITY DEFINER function cannot open the hatch for the app (session_user check)', async () => {
      if (!APP_URL) return;
      const app = new PrismaClient({ datasources: { db: { url: APP_URL } } });
      const fn = `zz_spoof_${randomUUID().replace(/-/g, '')}`;
      await owner.$executeRawUnsafe(`
        CREATE FUNCTION public.${fn}(p_org uuid) RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER
        SET search_path = public, pg_temp AS $f$
        DECLARE n bigint;
        BEGIN
          ALTER TABLE audit_events NO FORCE ROW LEVEL SECURITY;
          UPDATE audit_events SET action = 'tampered' WHERE org_id = p_org;
          GET DIAGNOSTICS n = ROW_COUNT;
          ALTER TABLE audit_events FORCE ROW LEVEL SECURITY;
          RETURN n;
        END $f$`);
      await owner.$executeRawUnsafe(`GRANT EXECUTE ON FUNCTION public.${fn}(uuid) TO meetops_app`);
      try {
        await expect(
          app.$transaction(async (tx) => {
            await tx.$executeRaw`SELECT set_config('meetops.audit_maintenance', 'on', true)`;
            return tx.$queryRawUnsafe(`SELECT public.${fn}($1::uuid)`, organizationId);
          }),
        ).rejects.toThrow(/append-only/);
      } finally {
        await owner.$executeRawUnsafe(`DROP FUNCTION public.${fn}(uuid)`);
        await app.$disconnect();
      }
      const forced = await owner.$queryRaw<{ f: boolean }[]>`
        SELECT relforcerowsecurity AS f FROM pg_class WHERE oid = 'public.audit_events'::regclass`;
      expect(forced).toEqual([{ f: true }]);
    });

    it('every table with RLS enabled is forced', async () => {
      const notForced = await owner.$queryRaw<{ relname: string }[]>`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity AND NOT c.relforcerowsecurity`;
      expect(notForced).toEqual([]);
      const enabled = await owner.$queryRaw<{ relname: string }[]>`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relrowsecurity`;
      expect(enabled.map((r) => r.relname).sort()).toEqual([...TENANT_TABLES].sort());
      await owner.$disconnect();
    });
  },
);

describe.skipIf(!APP_URL || !OWNER_URL)('ADR-010 organization context setting (live)', () => {
  const app = new PrismaClient({ datasources: { db: { url: APP_URL ?? '' } } });
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL ?? '' } } });
  const orgA = randomUUID();
  const orgB = randomUUID();

  const countWith = (settings: [string, string][]) =>
    app.$transaction(async (tx) => {
      for (const [name, value] of settings) {
        await tx.$executeRaw`SELECT set_config(${name}, ${value}, true)`;
      }
      return tx.project.count({ where: { organizationId: { in: [orgA, orgB] } } });
    });

  it('setup', async () => {
    await owner.organization.createMany({
      data: [
        { id: orgA, name: 'A', slug: `a10-${orgA}` },
        { id: orgB, name: 'B', slug: `b10-${orgB}` },
      ],
    });
    for (const organizationId of [orgA, orgB]) {
      await runWithOrganizationContext(owner, organizationId, (tx) =>
        tx.project.create({ data: { organizationId, name: 'P', key: 'P' } }),
      );
    }
  });

  it('new GUC alone scopes to one organization', async () => {
    expect(await countWith([['app.current_organization_id', orgA]])).toBe(1);
  });

  it('legacy GUC alone still scopes to one organization (deprecated fallback)', async () => {
    expect(await countWith([['app.current_org_id', orgA]])).toBe(1);
  });

  it('new GUC wins over a conflicting legacy GUC', async () => {
    const rows = await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_organization_id', ${orgA}, true)`;
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgB}, true)`;
      return tx.project.findMany({ where: { organizationId: { in: [orgA, orgB] } } });
    });
    expect(rows.map((r) => r.organizationId)).toEqual([orgA]);
  });

  it('no GUC or empty GUCs => 0 rows (fail-closed)', async () => {
    expect(await countWith([])).toBe(0);
    expect(
      await countWith([
        ['app.current_organization_id', ''],
        ['app.current_org_id', ''],
      ]),
    ).toBe(0);
  });

  it('deprecated runWithOrgContext still works', async () => {
    expect(await runWithOrgContext(app, orgB, (tx) => tx.project.count())).toBe(1);
    await app.$disconnect();
    await owner.$disconnect();
  });
});

describe.skipIf(!APP_URL || !OWNER_URL)('DB-1 teams and team_members RLS (live)', () => {
  const app = new PrismaClient({ datasources: { db: { url: APP_URL ?? '' } } });
  const owner = new PrismaClient({ datasources: { db: { url: OWNER_URL ?? '' } } });
  const orgA = randomUUID();
  const orgB = randomUUID();
  const teamA = randomUUID();
  const teamB = randomUUID();
  const employeeA = randomUUID();
  const employeeB = randomUUID();
  const memberB = randomUUID();

  it('setup: one team, employee and member per org', async () => {
    await owner.organization.createMany({
      data: [
        { id: orgA, name: 'TA', slug: `ta-${orgA}` },
        { id: orgB, name: 'TB', slug: `tb-${orgB}` },
      ],
    });
    for (const [organizationId, teamId, employeeId, memberId] of [
      [orgA, teamA, employeeA, randomUUID()],
      [orgB, teamB, employeeB, memberB],
    ] as const) {
      await runWithOrganizationContext(owner, organizationId, async (tx) => {
        await tx.team.create({ data: { id: teamId, organizationId, name: 'Platform' } });
        await tx.employee.create({ data: { id: employeeId, organizationId, fullName: 'E' } });
        await tx.teamMember.create({
          data: { id: memberId, organizationId, teamId, employeeId, role: 'lead' },
        });
      });
    }
  });

  it('no context => 0 teams and 0 team_members', async () => {
    expect(await app.team.count()).toBe(0);
    expect(await app.teamMember.count()).toBe(0);
  });

  it('org A context sees only its own team and member', async () => {
    const [teams, members] = await runWithOrganizationContext(app, orgA, (tx) =>
      Promise.all([tx.team.findMany(), tx.teamMember.findMany()]),
    );
    expect(teams.map((t) => t.id)).toEqual([teamA]);
    expect(members.map((m) => m.organizationId)).toEqual([orgA]);
    expect(
      await runWithOrganizationContext(app, orgA, (tx) =>
        tx.team.findUnique({ where: { id: teamB } }),
      ),
    ).toBeNull();
  });

  it('org A context cannot insert teams or team_members into org B', async () => {
    await expect(
      runWithOrganizationContext(app, orgA, (tx) =>
        tx.team.create({ data: { organizationId: orgB, name: 'Injected' } }),
      ),
    ).rejects.toThrow();
    await expect(
      runWithOrganizationContext(app, orgA, (tx) =>
        tx.teamMember.create({
          data: { organizationId: orgB, teamId: teamB, employeeId: employeeB, role: 'member' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('org A context cannot update org B rows, nor move its own rows into org B', async () => {
    const hidden = await runWithOrganizationContext(app, orgA, async (tx) => ({
      teams: await tx.team.updateMany({ where: { id: teamB }, data: { name: 'Pwned' } }),
      members: await tx.teamMember.updateMany({ where: { id: memberB }, data: { role: 'member' } }),
    }));
    expect(hidden).toEqual({ teams: { count: 0 }, members: { count: 0 } });
    await expect(
      runWithOrganizationContext(
        app,
        orgA,
        (tx) => tx.$executeRaw`UPDATE teams SET org_id = ${orgB}::uuid WHERE id = ${teamA}::uuid`,
      ),
    ).rejects.toThrow();
    const b = await runWithOrganizationContext(owner, orgB, (tx) =>
      Promise.all([
        tx.team.findUniqueOrThrow({ where: { id: teamB } }),
        tx.teamMember.findUniqueOrThrow({ where: { id: memberB } }),
      ]),
    );
    expect(b[0].name).toBe('Platform');
    expect(b[1].role).toBe('lead');
  });

  it('a cross-org FK fails: an org A member row cannot reference an org B team or employee', async () => {
    // Even as the owner (whose writes pass the org A policy), the composite FK rejects org B parents.
    await expect(
      runWithOrganizationContext(owner, orgA, (tx) =>
        tx.teamMember.create({
          data: { organizationId: orgA, teamId: teamB, employeeId: employeeA },
        }),
      ),
    ).rejects.toThrow(/foreign key|Foreign key/);
    await expect(
      runWithOrganizationContext(owner, orgA, (tx) =>
        tx.teamMember.create({
          data: { organizationId: orgA, teamId: teamA, employeeId: employeeB },
        }),
      ),
    ).rejects.toThrow(/foreign key|Foreign key/);
    await expect(
      runWithOrganizationContext(owner, orgA, (tx) =>
        tx.project.create({ data: { organizationId: orgA, name: 'X', key: 'X', teamId: teamB } }),
      ),
    ).rejects.toThrow(/foreign key|Foreign key/);
  });

  it('a same-org project can belong to a team; duplicate members and team names are rejected', async () => {
    const project = await runWithOrganizationContext(app, orgA, (tx) =>
      tx.project.create({ data: { organizationId: orgA, name: 'TP', key: 'TP', teamId: teamA } }),
    );
    expect(project.teamId).toBe(teamA);
    await expect(
      runWithOrganizationContext(app, orgA, (tx) =>
        tx.teamMember.create({
          data: { organizationId: orgA, teamId: teamA, employeeId: employeeA },
        }),
      ),
    ).rejects.toMatchObject({ code: 'P2002' });
    await expect(
      runWithOrganizationContext(app, orgA, (tx) =>
        tx.team.create({ data: { organizationId: orgA, name: 'Platform' } }),
      ),
    ).rejects.toMatchObject({ code: 'P2002' });
    // 'Platform' exists in both orgs (setup), so names are unique per organization, not globally.
  });

  it('the legacy setting alone does not open the new tables (ADR-010 setting only)', async () => {
    const count = await app.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_org_id', ${orgA}, true)`;
      return tx.team.count();
    });
    expect(count).toBe(0);
    await app.$disconnect();
    await owner.$disconnect();
  });
});
