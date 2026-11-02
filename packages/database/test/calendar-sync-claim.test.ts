import { describe, expect, it, vi } from 'vitest';
import { createCalendarSyncRepository } from '../src/calendar-sync.js';

const ORG = '00000000-0000-4000-8000-00000000000a';
const ID = '00000000-0000-4000-8000-0000000000c1';
const LEASE = new Date('2026-10-31T10:10:00Z');

/** Fake Prisma client: the transaction runs inline; raw queries are captured. */
function fakeClient(rows: { next_sync_at: Date }[], executed = 1) {
  const queryRaw = vi.fn<(...a: unknown[]) => Promise<typeof rows>>(async () => rows);
  const executeRaw = vi.fn<(...a: unknown[]) => Promise<number>>(async () => executed);
  const updateMany = vi.fn<(a: { where: Record<string, unknown> }) => Promise<{ count: number }>>(
    async () => ({ count: executed }),
  );
  const tx = {
    $executeRaw: executeRaw,
    $queryRaw: queryRaw,
    calendarConnection: { updateMany },
  };
  const client = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  return { client: client as never, queryRaw, executeRaw, updateMany };
}
const sqlOf = (call: unknown[]) => (call[0] as string[]).join('?');

describe('calendar sync repository claimForSync', () => {
  it('claims with one conditional UPDATE timed by clock_timestamp() and returns the lease token', async () => {
    const f = fakeClient([{ next_sync_at: LEASE }]);
    const repo = createCalendarSyncRepository({ client: f.client });
    await expect(repo.claimForSync(ORG, ID, 600_000)).resolves.toEqual({ lease: LEASE });
    const call = f.queryRaw.mock.calls[0]!;
    const sql = sqlOf(call);
    expect(sql).toMatch(/UPDATE calendar_connections/);
    expect(sql).toMatch(/next_sync_at <= clock_timestamp\(\)/);
    expect(sql).toMatch(/SET next_sync_at = clock_timestamp\(\)/);
    expect(sql).toMatch(/status = 'active'/);
    expect(call.slice(1)).toEqual([600_000, ID, ORG]);
  });
  it('returns null when another replica holds it', async () => {
    const repo = createCalendarSyncRepository({ client: fakeClient([]).client });
    await expect(repo.claimForSync(ORG, ID, 600_000)).resolves.toBeNull();
  });
  it('rejects bad ids and leases without a query', async () => {
    const f = fakeClient([{ next_sync_at: LEASE }]);
    const repo = createCalendarSyncRepository({ client: f.client });
    await expect(repo.claimForSync(ORG, 'not-a-uuid', 600_000)).resolves.toBeNull();
    await expect(repo.claimForSync(ORG, ID, 0)).resolves.toBeNull();
    await expect(repo.claimForSync(ORG, ID, 1.5)).resolves.toBeNull();
    expect(f.queryRaw).not.toHaveBeenCalled();
  });
  it('recordFailure with a lease only writes while next_sync_at still equals it', async () => {
    const f = fakeClient([], 0);
    const repo = createCalendarSyncRepository({ client: f.client });
    await expect(
      repo.recordFailure(ORG, ID, { syncFailures: 2, retryInMs: 60_000, lease: LEASE }),
    ).resolves.toBe(false);
    const call = f.executeRaw.mock.calls.at(-1)!;
    expect(sqlOf(call)).toMatch(/next_sync_at = \?::timestamptz/);
    expect(sqlOf(call)).toMatch(/clock_timestamp\(\)/);
  });
  it('markError with a lease only marks while next_sync_at still equals it (#353 L1)', async () => {
    const f = fakeClient([], 0);
    const repo = createCalendarSyncRepository({ client: f.client });
    await expect(repo.markError(ORG, ID, { lease: LEASE })).resolves.toBe(false);
    expect(f.updateMany.mock.calls.at(-1)![0].where).toEqual({
      id: ID,
      organizationId: ORG,
      status: 'active',
      nextSyncAt: LEASE,
    });
    const g = fakeClient([], 1);
    await expect(
      createCalendarSyncRepository({ client: g.client }).markError(ORG, ID),
    ).resolves.toBe(true);
    expect(g.updateMany.mock.calls.at(-1)![0].where).not.toHaveProperty('nextSyncAt');
  });
  it('updateTokens with a lease only writes while active and the claim is still held', async () => {
    const cipher = {
      encrypt: vi.fn(async (v: string) => `v1.k1.n${v.length}.ct`),
      decrypt: vi.fn(async () => 'x'),
    };
    const t = { accessToken: 'a', refreshToken: 'r', accessTokenExpiresAt: LEASE };
    const f = fakeClient([], 0);
    const repo = createCalendarSyncRepository({ client: f.client, cipher });
    await expect(repo.updateTokens(ORG, ID, t, { lease: LEASE })).resolves.toBe(false);
    expect(f.updateMany.mock.calls.at(-1)![0].where).toEqual({
      id: ID,
      organizationId: ORG,
      status: 'active',
      nextSyncAt: LEASE,
    });
    const g = fakeClient([], 1);
    const r2 = createCalendarSyncRepository({ client: g.client, cipher });
    await expect(r2.updateTokens(ORG, ID, t)).resolves.toBe(true);
    expect(g.updateMany.mock.calls.at(-1)![0].where).toEqual({
      id: ID,
      organizationId: ORG,
      status: 'active',
    });
  });
  it('readSecrets accepts the shared legacy context only for a fully legacy row', async () => {
    const legacyCtx = { organizationId: ORG, integrationId: ID };
    // access decrypts under its v2 field context, refresh only under the legacy shared one.
    const cipher = {
      encrypt: vi.fn(),
      decrypt: vi.fn(async (enc: string, c: { integrationId: string }) => {
        if (enc === 'acc' && c.integrationId === `calendar:${ID}:access`) return 'access-v2';
        if (enc === 'ref' && c.integrationId === legacyCtx.integrationId) return 'refresh-legacy';
        if (enc === 'accL' && c.integrationId === legacyCtx.integrationId) return 'access-legacy';
        throw new Error('bad aad');
      }),
    };
    const row = (accessTokenEnc: string) => ({
      userId: 'u',
      provider: 'google',
      accessTokenEnc,
      refreshTokenEnc: 'ref',
      accessTokenExpiresAt: null,
      syncFailures: 0,
      syncCursorEnc: null,
      syncCursorFrom: null,
      syncCursorTo: null,
    });
    const withRow = (r: unknown) => {
      const tx = {
        $executeRaw: vi.fn(async () => 1),
        calendarConnection: { findFirst: vi.fn(async () => r) },
      };
      return { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) } as never;
    };
    const mixed = await createCalendarSyncRepository({
      client: withRow(row('acc')),
      cipher,
    }).readSecrets(ORG, ID);
    expect(mixed).toMatchObject({ accessToken: 'access-v2', refreshToken: null });
    const legacy = await createCalendarSyncRepository({
      client: withRow(row('accL')),
      cipher,
    }).readSecrets(ORG, ID);
    expect(legacy).toMatchObject({ accessToken: 'access-legacy', refreshToken: 'refresh-legacy' });
  });
});
