/**
 * Phase 7 calendar connections over live Postgres (forced RLS, meetops_app role, TokenCipher envelopes). Skipped
 * unless TEST_DATABASE_URL (app role) and TEST_OWNER_DATABASE_URL (migrator, to create orgs/users) are set.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  createPrismaClient,
  withOrganizationContext,
  type DatabaseClient,
} from '@meetops/database';
import { LocalKeyProvider, TokenCipher } from '@meetops/integrations';
import { PrismaCalendarConnections } from '../src/modules/calendar/prisma.repository.js';
import { PrismaCalendarEventLinks } from '../src/modules/calendar/links.repository.js';

const url = process.env.TEST_DATABASE_URL;
const owner = process.env.TEST_OWNER_DATABASE_URL;

describe.skipIf(!url || !owner)(
  'Phase 7 PrismaCalendarConnections (live RLS)',
  { timeout: 60_000 },
  () => {
    let db: DatabaseClient;
    const orgA = randomUUID();
    const orgB = randomUUID();
    const user = randomUUID();
    const cipher = new TokenCipher(new LocalKeyProvider({ k1: randomBytes(32) }, 'k1'));

    beforeAll(async () => {
      const o = createPrismaClient({ databaseUrl: owner! });
      for (const id of [orgA, orgB])
        await o.organization.create({ data: { id, name: 'Cal', slug: `cal-${id.slice(0, 8)}` } });
      await o.user.create({
        data: { id: user, email: `cal-${user.slice(0, 8)}@example.com`, name: 'Cal' },
      });
      await o.$disconnect();
      db = createPrismaClient({ databaseUrl: url! });
    });
    afterAll(async () => db?.$disconnect());

    it('stores envelopes only, scopes by org and user, and revoke wipes tokens', async () => {
      const repo = new PrismaCalendarConnections(db, cipher);
      const row = await repo.upsert(orgA, {
        userId: user,
        provider: 'google',
        displayName: 'Me',
        externalAccountId: 'me@example.test',
        accessToken: 'plain-access',
        refreshToken: 'plain-refresh',
        accessTokenExpiresAt: new Date(Date.now() + 3600e3),
      });
      const raw = await db.$queryRaw<
        { n: bigint }[]
      >`SELECT count(*)::bigint AS n FROM calendar_connections`;
      expect(Number(raw[0]!.n)).toBe(0); // no org context => forced RLS hides every row
      expect(await repo.listForUser(orgB, user)).toEqual([]);
      expect(await repo.readSecrets(orgB, user, row.id)).toBeNull();
      expect(await repo.readSecrets(orgA, randomUUID(), row.id)).toBeNull();
      expect((await repo.readSecrets(orgA, user, row.id))?.accessToken).toBe('plain-access');

      // At rest: only v1 envelopes, never the plaintext; access/refresh use different AAD.
      const stored = await withOrganizationContext(
        orgA,
        (tx) =>
          tx.$queryRaw<{ a: string; r: string; k: string }[]>`
          SELECT access_token_enc AS a, refresh_token_enc AS r, token_key_id AS k
            FROM calendar_connections WHERE id = ${row.id}::uuid`,
        { client: db },
      );
      const { a, r, k } = stored[0]!;
      for (const env of [a, r]) {
        expect(env).toMatch(/^v1\.k1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
        expect(env).not.toContain('plain-');
        expect(Buffer.from(env.split('.')[3]!, 'base64url').toString('utf8')).not.toContain(
          'plain-',
        );
      }
      expect(k).toBe('k1');
      await expect(
        cipher.decrypt(a, { organizationId: orgA, integrationId: `calendar:${row.id}:refresh` }),
      ).rejects.toThrow();
      await expect(
        cipher.decrypt(a, { organizationId: orgB, integrationId: `calendar:${row.id}:access` }),
      ).rejects.toThrow();

      const again = await repo.upsert(orgA, {
        userId: user,
        provider: 'google',
        displayName: 'Me 2',
        externalAccountId: 'me@example.test',
        accessToken: 'plain-access-2',
        refreshToken: 'plain-refresh',
        accessTokenExpiresAt: new Date(Date.now() + 3600e3),
      });
      expect(again.id).toBe(row.id);
      expect(await repo.revoke(orgA, user, row.id)).toBe(true);
      expect(await repo.readSecrets(orgA, user, row.id)).toBeNull();
      expect((await repo.listForUser(orgA, user))[0]!.status).toBe('revoked');
    });

    it('re-encrypts rows from the old AAD context and treats undecryptable rows as disconnected', async () => {
      const repo = new PrismaCalendarConnections(db, cipher);
      const legacy = await repo.upsert(orgB, {
        userId: user,
        provider: 'google',
        displayName: 'Old',
        externalAccountId: 'old@example.test',
        accessToken: 'x',
        refreshToken: 'y',
        accessTokenExpiresAt: new Date(Date.now() + 3600e3),
      });
      const old = { organizationId: orgB, integrationId: legacy.id };
      const oa = await cipher.encrypt('old-access', old);
      const or = await cipher.encrypt('old-refresh', old);
      await withOrganizationContext(
        orgB,
        (tx) =>
          tx.calendarConnection.update({
            where: { id: legacy.id },
            data: { accessTokenEnc: oa, refreshTokenEnc: or },
          }),
        { client: db },
      );
      const s1 = await repo.readSecrets(orgB, user, legacy.id);
      expect(s1).toMatchObject({ accessToken: 'old-access', refreshToken: 'old-refresh' });
      const after = await withOrganizationContext(
        orgB,
        (tx) => tx.calendarConnection.findUniqueOrThrow({ where: { id: legacy.id } }),
        { client: db },
      );
      await expect(
        cipher.decrypt(after.accessTokenEnc!, {
          organizationId: orgB,
          integrationId: `calendar:${legacy.id}:access`,
        }),
      ).resolves.toBe('old-access');
      // #317 Info 3: token_key_id tracks the key that wrote the re-encrypted envelope.
      expect(after.tokenKeyId).toBe(after.accessTokenEnc!.split('.')[1]);

      // A row that no known context can open: no throw (no 500), marked error so the user reconnects.
      const foreign = await new TokenCipher(
        new LocalKeyProvider({ k1: randomBytes(32) }, 'k1'),
      ).encrypt('z', old);
      await withOrganizationContext(
        orgB,
        (tx) =>
          tx.calendarConnection.update({
            where: { id: legacy.id },
            data: { accessTokenEnc: foreign },
          }),
        { client: db },
      );
      await expect(repo.readSecrets(orgB, user, legacy.id)).resolves.toBeNull();
      expect((await repo.listForUser(orgB, user))[0]!.status).toBe('error');
    });
    it('revoke deletes the connection event links in the same transaction; other links survive', async () => {
      const repo = new PrismaCalendarConnections(db, cipher);
      const links = new PrismaCalendarEventLinks(db);
      expect(repo.revokesLinks).toBe(true);
      const conn = (n: string) =>
        repo.upsert(orgA, {
          userId: user,
          provider: 'google',
          displayName: n,
          externalAccountId: `${n}@example.test`,
          accessToken: 'a',
          refreshToken: 'r',
          accessTokenExpiresAt: new Date(Date.now() + 3600e3),
        });
      const gone = await conn('links-gone');
      const kept = await conn('links-kept');
      const meeting = await withOrganizationContext(
        orgA,
        (tx) => tx.meeting.create({ data: { organizationId: orgA, title: 'linked' } }),
        { client: db },
      );
      expect(
        await links.upsert(orgA, user, {
          connectionId: gone.id,
          eventId: 'e1',
          meetingId: meeting.id,
        }),
      ).not.toBeNull();
      expect(
        await links.upsert(orgA, user, {
          connectionId: kept.id,
          eventId: 'e2',
          meetingId: meeting.id,
        }),
      ).not.toBeNull();

      expect(await repo.revoke(orgA, user, gone.id)).toBe(true);
      const rows = await withOrganizationContext(
        orgA,
        (tx) =>
          tx.calendarEventLink.findMany({
            where: { connectionId: { in: [gone.id, kept.id] } },
            select: { connectionId: true },
          }),
        { client: db },
      );
      expect(rows).toEqual([{ connectionId: kept.id }]);
      // Second revoke is a no-op (already revoked) and touches nothing.
      expect(await repo.revoke(orgA, user, gone.id)).toBe(false);
      expect(await links.listForUser(orgA, user, [kept.id])).toHaveLength(1);
    });
  },
);
