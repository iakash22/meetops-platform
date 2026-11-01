import { describe, expect, it, vi } from 'vitest';
import { createCalendarSyncRepository } from '../src/calendar-sync.js';

const ORG = '00000000-0000-4000-8000-00000000000a';
const ID = '00000000-0000-4000-8000-0000000000c1';
const LEASE = new Date('2026-10-31T10:10:00Z');

/** Fake Prisma client: the transaction runs inline; raw queries are captured. */
function fakeClient(rows: { next_sync_at: Date }[], executed = 1) {
  const queryRaw = vi.fn<(...a: unknown[]) => Promise<typeof rows>>(async () => rows);
  const executeRaw = vi.fn<(...a: unknown[]) => Promise<number>>(async () => executed);
  const tx = { $executeRaw: executeRaw, $queryRaw: queryRaw };
  const client = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  return { client: client as never, queryRaw, executeRaw };
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
});
