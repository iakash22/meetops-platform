import { describe, expect, it, vi } from 'vitest';
import { createCalendarSyncRepository } from '../src/calendar-sync.js';

const ORG = '00000000-0000-4000-8000-00000000000a';
const ID = '00000000-0000-4000-8000-0000000000c1';
const NOW = new Date('2026-10-31T10:00:00Z');
const LEASE = new Date('2026-10-31T10:10:00Z');

/** Fake Prisma client: the transaction runs inline; updateMany returns the given count. */
function fakeClient(count: number) {
  const updateMany = vi.fn(async () => ({ count }));
  const tx = { $executeRaw: vi.fn(async () => 0), calendarConnection: { updateMany } };
  const client = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
  return { client: client as never, updateMany, tx };
}

describe('calendar sync repository claimForSync', () => {
  it('claims with one conditional UPDATE (active + due) in the org context', async () => {
    const f = fakeClient(1);
    const repo = createCalendarSyncRepository({ client: f.client });
    await expect(repo.claimForSync(ORG, ID, NOW, LEASE)).resolves.toBe(true);
    expect(f.updateMany).toHaveBeenCalledWith({
      where: {
        id: ID,
        organizationId: ORG,
        status: 'active',
        OR: [{ nextSyncAt: null }, { nextSyncAt: { lte: NOW } }],
      },
      data: { nextSyncAt: LEASE },
    });
    expect(f.tx.$executeRaw).toHaveBeenCalled();
  });
  it('returns false when another replica already moved next_sync_at', async () => {
    const repo = createCalendarSyncRepository({ client: fakeClient(0).client });
    await expect(repo.claimForSync(ORG, ID, NOW, LEASE)).resolves.toBe(false);
  });
  it('rejects bad ids and non-forward leases without a query', async () => {
    const f = fakeClient(1);
    const repo = createCalendarSyncRepository({ client: f.client });
    await expect(repo.claimForSync(ORG, 'not-a-uuid', NOW, LEASE)).resolves.toBe(false);
    await expect(repo.claimForSync(ORG, ID, NOW, NOW)).resolves.toBe(false);
    expect(f.updateMany).not.toHaveBeenCalled();
  });
});
