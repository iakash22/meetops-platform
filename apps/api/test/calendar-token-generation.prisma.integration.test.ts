/**
 * #394 N1/N2 over live Postgres (forced RLS, meetops_app role): token writes from the API and the worker are a
 * compare-and-set on token_generation (a reconnect bumps it), and a legacy Google row keeps its pre-v2 refresh
 * token valid after a refresh that omits refresh_token (refresh_enc_version records its context).
 * Skipped unless TEST_DATABASE_URL (app role) and TEST_OWNER_DATABASE_URL (migrator) are set.
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

const url = process.env.TEST_DATABASE_URL;
const owner = process.env.TEST_OWNER_DATABASE_URL;

describe.skipIf(!url || !owner)('calendar token generation (live RLS)', { timeout: 60_000 }, () => {
  let db: DatabaseClient;
  const org = randomUUID();
  const user = randomUUID();
  const cipher = new TokenCipher(new LocalKeyProvider({ k1: randomBytes(32) }, 'k1'));
  const LATER = new Date(Date.now() + 3600e3);
  const input = (externalAccountId: string, over: Record<string, string> = {}) => ({
    userId: user,
    provider: 'google' as const,
    displayName: 'Me',
    externalAccountId,
    accessToken: 'A1',
    refreshToken: 'R1',
    accessTokenExpiresAt: LATER,
    ...over,
  });
  const tokens = (a: string, r: string) => ({
    accessToken: a,
    refreshToken: r,
    accessTokenExpiresAt: LATER,
  });
  const raw = async (id: string) =>
    (
      await withOrganizationContext(
        org,
        (tx) => tx.$queryRaw<{ g: number; v: number | null }[]>`
          SELECT token_generation AS g, refresh_enc_version AS v
            FROM calendar_connections WHERE id = ${id}::uuid`,
        { client: db },
      )
    )[0]!;
  const legacy = (v: string, id: string) =>
    cipher.encrypt(v, { organizationId: org, integrationId: id });
  const v2 = (v: string, id: string, f: 'access' | 'refresh') =>
    cipher.encrypt(v, { organizationId: org, integrationId: `calendar:${id}:${f}` });
  const setRow = (id: string, a: string, r: string, version: number | null) =>
    withOrganizationContext(
      org,
      (tx) => tx.$executeRaw`
        UPDATE calendar_connections
           SET access_token_enc = ${a}, refresh_token_enc = ${r}, refresh_enc_version = ${version}::smallint,
               status = 'active'
         WHERE id = ${id}::uuid`,
      { client: db },
    );

  beforeAll(async () => {
    const o = createPrismaClient({ databaseUrl: owner! });
    await o.organization.create({ data: { id: org, name: 'Gen', slug: `gen-${org.slice(0, 8)}` } });
    await o.user.create({ data: { id: user, email: `gen-${user.slice(0, 8)}@example.com` } });
    await o.$disconnect();
    db = createPrismaClient({ databaseUrl: url! });
  });
  afterAll(async () => db?.$disconnect());

  it('API and worker refreshes racing on the same generation: exactly one write wins', async () => {
    const conns = new PrismaCalendarConnections(db, cipher);
    const sync = createCalendarSyncRepository({ client: db, cipher });
    const c = await conns.upsert(org, input('race@example.test'));
    const apiRead = await conns.readSecrets(org, user, c.id);
    const workerRead = await sync.readSecrets(org, c.id);
    expect(apiRead?.tokenGeneration).toBe(workerRead?.tokenGeneration);
    const g = workerRead!.tokenGeneration;
    // Both refreshes are in flight with the generation they read; the provider rotated the refresh token.
    const results = await Promise.all([
      conns.updateTokens(org, c.id, tokens('API-A', 'API-R'), { generation: g }),
      sync.updateTokens(org, c.id, tokens('W-A', 'W-R'), { generation: g }),
      sync.updateTokens(org, c.id, tokens('W2-A', 'W2-R'), { generation: g }),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const after = await sync.readSecrets(org, c.id);
    expect(after?.tokenGeneration).toBe(g + 1);
    const winner = ['API', 'W', 'W2'][results.indexOf(true)];
    expect(after).toMatchObject({ accessToken: `${winner}-A`, refreshToken: `${winner}-R` });
    // A loser retrying with its stale generation is still refused.
    expect(await conns.updateTokens(org, c.id, tokens('X', 'X'), { generation: g })).toBe(false);
  });

  it('reconnect bumps the generation: a refresh started on the old grant cannot overwrite the new one', async () => {
    const conns = new PrismaCalendarConnections(db, cipher);
    const sync = createCalendarSyncRepository({ client: db, cipher });
    const c = await conns.upsert(org, input('reconnect@example.test'));
    const apiRead = await conns.readSecrets(org, user, c.id);
    const workerRead = await sync.readSecrets(org, c.id);
    expect(await conns.revoke(org, user, c.id)).toBe(true);
    await conns.upsert(
      org,
      input('reconnect@example.test', { accessToken: 'NEW-A', refreshToken: 'NEW-R' }),
    );
    expect(
      await conns.updateTokens(org, c.id, tokens('OLD-A', 'OLD-R'), {
        generation: apiRead!.tokenGeneration,
      }),
    ).toBe(false);
    expect(
      await sync.updateTokens(org, c.id, tokens('OLD-A', 'OLD-R'), {
        generation: workerRead!.tokenGeneration,
      }),
    ).toBe(false);
    expect(await sync.readSecrets(org, c.id)).toMatchObject({
      accessToken: 'NEW-A',
      refreshToken: 'NEW-R',
    });
    expect((await raw(c.id)).g).toBe(workerRead!.tokenGeneration + 2);
  });

  it('legacy Google row: a worker refresh without refresh_token keeps the legacy refresh token valid', async () => {
    const conns = new PrismaCalendarConnections(db, cipher);
    const sync = createCalendarSyncRepository({ client: db, cipher });
    const c = await conns.upsert(org, input('legacy@example.test'));
    // Row written before per-field AAD and before refresh_enc_version (NULL).
    await setRow(c.id, await legacy('LA', c.id), await legacy('LR', c.id), null);
    const s = await sync.readSecrets(org, c.id);
    expect(s).toMatchObject({ accessToken: 'LA', refreshToken: 'LR', refreshEncVersion: 1 });
    // Google omits refresh_token: access becomes v2, the legacy refresh ciphertext is kept and declared as 1.
    expect(
      await sync.updateTokens(org, c.id, tokens('NEW-A', ''), {
        generation: s!.tokenGeneration,
        refreshEncVersion: s!.refreshEncVersion,
      }),
    ).toBe(true);
    expect((await raw(c.id)).v).toBe(1);
    expect(await sync.readSecrets(org, c.id)).toMatchObject({
      accessToken: 'NEW-A',
      refreshToken: 'LR',
      refreshEncVersion: 1,
    });
    // The API reads it too (and re-encrypts the refresh token under v2).
    expect((await conns.readSecrets(org, user, c.id))?.refreshToken).toBe('LR');
    expect((await raw(c.id)).v).toBe(2);
    expect(await sync.readSecrets(org, c.id)).toMatchObject({
      refreshToken: 'LR',
      refreshEncVersion: 2,
    });
    // API refresh without refresh_token keeps the stored (v2) refresh token.
    const a = await conns.readSecrets(org, user, c.id);
    expect(
      await conns.updateTokens(org, c.id, tokens('API-A', ''), {
        generation: a!.tokenGeneration,
        refreshEncVersion: a!.refreshEncVersion,
      }),
    ).toBe(true);
    expect(await sync.readSecrets(org, c.id)).toMatchObject({
      accessToken: 'API-A',
      refreshToken: 'LR',
    });
  });

  it('rejects a refresh token whose declared version does not match, and undeclared mixed pairs', async () => {
    const conns = new PrismaCalendarConnections(db, cipher);
    const sync = createCalendarSyncRepository({ client: db, cipher });
    const c = await conns.upsert(org, input('mismatch@example.test'));
    // Legacy envelope declared as v2.
    await setRow(c.id, await v2('A', c.id, 'access'), await legacy('LR', c.id), 2);
    expect((await sync.readSecrets(org, c.id))?.refreshToken).toBeNull();
    // v2 envelope declared as legacy.
    await setRow(c.id, await v2('A', c.id, 'access'), await v2('R', c.id, 'refresh'), 1);
    expect((await sync.readSecrets(org, c.id))?.refreshToken).toBeNull();
    // Undeclared (pre-migration) v2 access + legacy-only refresh: still a moved envelope.
    await setRow(c.id, await v2('A', c.id, 'access'), await legacy('LA-as-refresh', c.id), null);
    expect((await sync.readSecrets(org, c.id))?.refreshToken).toBeNull();
    // Matching declaration is accepted.
    await setRow(c.id, await v2('A', c.id, 'access'), await legacy('LR', c.id), 1);
    expect((await sync.readSecrets(org, c.id))?.refreshToken).toBe('LR');
  });
});
