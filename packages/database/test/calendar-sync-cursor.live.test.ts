/**
 * Background sync cursor on a real Postgres, as meetops_app (forced RLS): applySync stores the incremental cursor
 * encrypted (never plaintext) with its window, readSecrets returns it decrypted, a delta round soft-cancels
 * removed ids regardless of start time, and `cursor: null` clears it. Skipped unless RLS_TEST_APP_URL and
 * RLS_TEST_ADMIN_URL are set.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { createCalendarSyncRepository } from '../src/calendar-sync.js';
import type { IntegrationSecretCipher } from '../src/integration-connections.js';

const APP_URL = process.env.RLS_TEST_APP_URL;
const ADMIN_URL = process.env.RLS_TEST_ADMIN_URL;
const live = Boolean(APP_URL && ADMIN_URL);

const ORG = randomUUID();
const USER = randomUUID();
const b64 = (s: string) => Buffer.from(s).toString('base64url');
/** Reversible test cipher bound to its AAD; output matches the v1 envelope shape the CHECKs require. */
const cipher: IntegrationSecretCipher = {
  encrypt: async (p, c) => `v1.k.${b64(c.integrationId)}.${b64(p)}`,
  decrypt: async (e, c) => {
    const [, , aad, body] = e.split('.');
    if (aad !== b64(c.integrationId)) throw new Error('aad mismatch');
    return Buffer.from(body!, 'base64url').toString();
  },
} as IntegrationSecretCipher;

describe.skipIf(!live)('calendar sync cursor (live)', () => {
  const app = new PrismaClient({ datasources: { db: { url: APP_URL ?? '' } } });
  const admin = new PrismaClient({ datasources: { db: { url: ADMIN_URL ?? '' } } });
  const repo = createCalendarSyncRepository({ client: app, cipher });
  const CONN = randomUUID();
  const now = new Date();
  const from = new Date(now.getTime() - 86_400_000);
  const to = new Date(now.getTime() + 86_400_000);
  const ev = (id: string, startsAt: Date) => ({
    id,
    title: id,
    startsAt: startsAt.toISOString(),
    endsAt: new Date(startsAt.getTime() + 60_000).toISOString(),
    allDay: false,
    attendeeCount: 1,
    status: 'confirmed' as const,
  });
  const row = async () =>
    (
      await admin.$queryRawUnsafe<{ enc: string | null; f: Date | null; t: Date | null }[]>(
        `SELECT sync_cursor_enc AS enc, sync_cursor_from AS f, sync_cursor_to AS t
           FROM calendar_connections WHERE id = $1::uuid`,
        CONN,
      )
    )[0]!;

  beforeAll(async () => {
    await admin.organization.create({ data: { id: ORG, name: 'cursor', slug: `cursor-${ORG}` } });
    await admin.user.create({ data: { id: USER, email: `cursor-${USER}@example.test` } });
    const acc = await cipher.encrypt('access-placeholder', {
      organizationId: ORG,
      integrationId: `calendar:${CONN}:access`,
    });
    await admin.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`);
      await tx.$executeRawUnsafe(
        `INSERT INTO calendar_connections (id, org_id, user_id, provider, display_name, external_account_id,
           access_token_enc, token_key_id, updated_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'outlook', 'fixture', $4, $5, 'k', now())`,
        CONN,
        ORG,
        USER,
        `ext-${CONN}`,
        acc,
      );
    });
  });
  afterAll(async () => {
    await admin.$executeRawUnsafe(
      `DELETE FROM calendar_events WHERE connection_id = $1::uuid`,
      CONN,
    );
    await admin.$executeRawUnsafe(`DELETE FROM calendar_connections WHERE id = $1::uuid`, CONN);
    await admin.$executeRawUnsafe(`DELETE FROM organizations WHERE id = $1::uuid`, ORG);
    await admin.$executeRawUnsafe(`DELETE FROM users WHERE id = $1::uuid`, USER);
    await app.$disconnect();
    await admin.$disconnect();
  });

  it('stores the cursor encrypted with its window and reads it back decrypted', async () => {
    const r = await repo.applySync(ORG, {
      connectionId: CONN,
      from,
      to,
      now,
      events: [ev('a', now), ev('far', new Date(now.getTime() + 3_600_000))],
      complete: true,
      nextSyncInMs: 60_000,
      cursor: 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=secret-ish',
    });
    expect(r.applied).toBe(true);
    const stored = await row();
    expect(stored.enc).toMatch(/^v1\./);
    expect(stored.enc).not.toContain('deltatoken');
    expect(stored.f?.getTime()).toBe(from.getTime());
    expect(stored.t?.getTime()).toBe(to.getTime());
    const s = await repo.readSecrets(ORG, CONN);
    expect(s?.syncCursor).toEqual({
      value: 'https://graph.microsoft.com/v1.0/me/calendarView/delta?$deltatoken=secret-ish',
      from,
      to,
    });
  });

  it('delta round: upserts, cancels removed ids only, keeps others; null clears the cursor', async () => {
    const r = await repo.applySync(ORG, {
      connectionId: CONN,
      from,
      to,
      now,
      events: [ev('b', now)],
      removedIds: ['far', 'unknown'],
      complete: false,
      nextSyncInMs: 60_000,
      cursor: 'next-cursor',
    });
    expect(r).toMatchObject({ upserted: 1, cancelled: 1, applied: true });
    const ev2 = await admin.$queryRawUnsafe<{ id: string; status: string }[]>(
      `SELECT provider_event_id AS id, status FROM calendar_events WHERE connection_id = $1::uuid ORDER BY 1`,
      CONN,
    );
    expect(ev2).toEqual([
      { id: 'a', status: 'confirmed' },
      { id: 'b', status: 'confirmed' },
      { id: 'far', status: 'cancelled' },
    ]);
    expect((await repo.readSecrets(ORG, CONN))?.syncCursor?.value).toBe('next-cursor');

    await repo.applySync(ORG, {
      connectionId: CONN,
      from,
      to,
      now,
      events: [],
      complete: false,
      nextSyncInMs: 60_000,
      cursor: null,
    });
    expect(await row()).toEqual({ enc: null, f: null, t: null });
  });

  it('the database rejects a plaintext cursor', async () => {
    await expect(
      admin.$executeRawUnsafe(
        `UPDATE calendar_connections SET sync_cursor_enc = 'https://x', sync_cursor_from = now(),
           sync_cursor_to = now() + interval '1 day' WHERE id = $1::uuid`,
        CONN,
      ),
    ).rejects.toThrow(/sync_cursor_envelope_check/);
  });
});
