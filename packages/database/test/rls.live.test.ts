/**
 * Live RLS checks XT-26..XT-29 (docs/12-security/test-cases.md).
 * Skipped unless RLS_TEST_APP_URL (connects as meetops_app) and RLS_TEST_OWNER_URL are set
 * against a migrated pgvector Postgres.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { TENANT_TABLES, runWithOrgContext, runWithUserContext } from '../src/tenant.js';

const APP_URL = process.env.RLS_TEST_APP_URL;
const OWNER_URL = process.env.RLS_TEST_OWNER_URL;

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
      await runWithOrgContext(owner, organizationId, (tx) =>
        tx.project.create({ data: { organizationId, name: 'P', key: 'P' } }),
      );
    }
  });

  it('XT-26: no context => 0 rows', async () => {
    expect(await app.project.count()).toBe(0);
  });

  it('XT-27: context A cannot insert org B rows', async () => {
    await expect(
      runWithOrgContext(app, orgA, (tx) =>
        tx.project.create({ data: { organizationId: orgB, name: 'x', key: 'X' } }),
      ),
    ).rejects.toThrow();
    expect(await runWithOrgContext(app, orgA, (tx) => tx.project.count())).toBe(1);
  });

  it('XT-28: context does not leak to the next transaction', async () => {
    await runWithOrgContext(app, orgA, (tx) => tx.project.count());
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
    await owner.organization.create({ data: { id: organizationId, name: 'Inv', slug: `inv-${organizationId}` } });
    await owner.user.createMany({
      data: [
        { id: userId, email: `invitee-${organizationId}@example.test` },
        { id: otherUserId, email: `other-${organizationId}@example.test` },
      ],
    });
    await runWithOrgContext(owner, organizationId, (tx) =>
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
      'status',
    ]);
    expect(rows[0]?.org_id).toBe(organizationId);
    const none = await app.$queryRaw<
      unknown[]
    >`SELECT * FROM lookup_invitation_by_token_hash(${'nope'})`;
    expect(none).toHaveLength(0);
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
    const state = await runWithOrgContext(app, organizationId, async (tx) => ({
      m: await tx.membership.count({ where: { userId } }),
      inv: await tx.invitation.findFirst({ where: { tokenHash } }),
      audit: await tx.auditEvent.count({ where: { action: 'invitation.accepted' } }),
    }));
    expect(state).toMatchObject({ m: 1, audit: 1 });
    expect(state.inv?.status).toBe('accepted');
    await expect(
      app.$queryRaw`SELECT * FROM accept_invitation(${tokenHash}, ${userId}::uuid)`,
    ).rejects.toThrow(/invitation_invalid/);
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
      await runWithOrgContext(owner, id, (tx) =>
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

  it('reads pending events across orgs without org context and marks them published', async () => {
    const pending = await relay.outboxEvent.findMany({
      where: { organizationId: { in: orgs }, status: 'pending' },
    });
    expect(pending.map((e) => e.organizationId).sort()).toEqual([...orgs].sort());
    const res = await relay.outboxEvent.updateMany({
      where: { id: { in: pending.map((e) => e.id) } },
      data: { status: 'published', publishedAt: new Date(), attempts: { increment: 1 } },
    });
    expect(res.count).toBe(2);
  });

  it('cannot touch other tables or insert/delete/change payload', async () => {
    await expect(relay.meeting.count()).rejects.toThrow(/permission denied/);
    await expect(relay.organization.count()).rejects.toThrow(/permission denied/);
    await expect(relay.outboxEvent.deleteMany({ where: { organizationId: { in: orgs } } })).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      relay.outboxEvent.create({
        data: {
          organizationId: orgs[0] ?? '',
          aggregateType: 'x',
          aggregateId: randomUUID(),
          eventType: 'x',
          payload: {},
        },
      }),
    ).rejects.toThrow(/permission denied/);
    await expect(
      relay.$executeRaw`UPDATE outbox_events SET payload = '{}'::jsonb WHERE false`,
    ).rejects.toThrow(/permission denied/);
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
      await runWithOrgContext(owner, id, (tx) =>
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

  it('global audit events (NULL org) are insert-only; org events readable only in-org', async () => {
    const action = `auth.login_failed.${randomUUID()}`;
    // NULL-org rows are invisible to the app, so INSERT ... RETURNING (Prisma create) is refused;
    // the app writes them with createMany (no RETURNING).
    await expect(
      app.auditEvent.create({ data: { action, targetType: 'user', metadata: {} } }),
    ).rejects.toThrow(/row-level security/);
    expect(
      await app.auditEvent.createMany({ data: [{ action, targetType: 'user', metadata: {} }] }),
    ).toEqual({ count: 1 });
    expect(await app.auditEvent.count({ where: { action } })).toBe(0);
    expect(
      await runWithOrgContext(app, orgA, (tx) => tx.auditEvent.count({ where: { action } })),
    ).toBe(0);
    const orgAction = `org.updated.${randomUUID()}`;
    await runWithOrgContext(app, orgA, (tx) =>
      tx.auditEvent.create({ data: { organizationId: orgA, action: orgAction, targetType: 'org' } }),
    );
    expect(
      await runWithOrgContext(app, orgA, (tx) =>
        tx.auditEvent.count({ where: { action: orgAction } }),
      ),
    ).toBe(1);
    expect(
      await runWithOrgContext(app, orgB, (tx) =>
        tx.auditEvent.count({ where: { action: orgAction } }),
      ),
    ).toBe(0);
    await expect(
      runWithOrgContext(app, orgA, (tx) =>
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
    await runWithOrgContext(app, organizationId, (tx) =>
      tx.meeting.create({ data: { id: meetingId, organizationId, title: 'Media' } }),
    );
  });

  it('stores recording, normalized and chunk file_objects with the worker UUIDv5 ids (idempotent retry)', async () => {
    const { normalizedFileObjectId, chunkFileObjectId } = await import('./media-ids.js');
    const normId = normalizedFileObjectId(recordingId);
    const chunkIds = [0, 1, 2].map((i) => chunkFileObjectId(recordingId, i));
    const write = () =>
      runWithOrgContext(app, organizationId, async (tx) => {
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
          create: { id: recordingId, organizationId, meetingId, fileObjectId: rawId, status: 'processing' },
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
    const rows = await runWithOrgContext(app, organizationId, (tx) =>
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
      runWithOrgContext(app, organizationId, (tx) =>
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
      await runWithOrgContext(app, otherOrg, (tx) =>
        tx.fileObject.count({ where: { id: normId } }),
      ),
    ).toBe(0);
  });

  it('recording session lifecycle: chunks, duplicate seq refused, complete links the recording', async () => {
    const sessionId = randomUUID();
    await runWithOrgContext(app, organizationId, async (tx) => {
      await tx.recordingSession.create({
        data: { id: sessionId, organizationId, meetingId, mimeType: 'audio/webm', startedAt: new Date() },
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
      runWithOrgContext(app, organizationId, (tx) =>
        tx.recordingSessionChunk.create({
          data: { organizationId, sessionId, seq: 1, sizeBytes: 10, storageKey: `${base}/x.part` },
        }),
      ),
    ).rejects.toThrow();
    // completed requires a recording
    await expect(
      runWithOrgContext(app, organizationId, (tx) =>
        tx.recordingSession.update({ where: { id: sessionId }, data: { status: 'completed' } }),
      ),
    ).rejects.toThrow();
    const done = await runWithOrgContext(app, organizationId, (tx) =>
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
      await runWithOrgContext(app, otherOrg, (tx) =>
        tx.recordingSession.count({ where: { id: sessionId } }),
      ),
    ).toBe(0);
    expect(await app.recordingSessionChunk.count({ where: { sessionId } })).toBe(0);
  });

  it('abort needs a reason; chunk keys must sit under the org prefix', async () => {
    const sessionId = randomUUID();
    await runWithOrgContext(app, organizationId, (tx) =>
      tx.recordingSession.create({
        data: { id: sessionId, organizationId, meetingId, mimeType: 'audio/webm', startedAt: new Date() },
      }),
    );
    await expect(
      runWithOrgContext(app, organizationId, (tx) =>
        tx.recordingSession.update({ where: { id: sessionId }, data: { status: 'aborted' } }),
      ),
    ).rejects.toThrow();
    await runWithOrgContext(app, organizationId, (tx) =>
      tx.recordingSession.update({
        where: { id: sessionId },
        data: { status: 'aborted', abortReason: 'tab_closed', abortedAt: new Date() },
      }),
    );
    await expect(
      runWithOrgContext(app, organizationId, (tx) =>
        tx.recordingSessionChunk.create({
          data: { organizationId, sessionId, seq: 0, sizeBytes: 1, storageKey: `org/${otherOrg}/x.part` },
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
