import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryCalendarConnections } from '../src/modules/calendar/in-memory.repository.js';
import type { CalendarEventLinksRepository } from '../src/modules/calendar/ports.js';
import { PrismaCalendarConnections } from '../src/modules/calendar/prisma.repository.js';
import { CalendarService } from '../src/modules/calendar/service.js';
import type { DatabaseClient } from '../src/shared/prisma/context.js';

const org = randomUUID();
const user = randomUUID();

/** Fake interactive transaction: records the calls made inside it and rolls back (throws) like Prisma would. */
function fakeDb(opts: { failLinkDelete?: boolean } = {}) {
  const calls: string[] = [];
  const updates: { where?: unknown; data: Record<string, unknown> }[] = [];
  let committed = false;
  const tx = {
    $executeRaw: async () => 1,
    $queryRaw: async () => {
      calls.push('purgeEvents');
      return [];
    },
    calendarConnection: {
      updateMany: async (args: { where?: unknown; data: Record<string, unknown> }) => {
        updates.push(args);
        calls.push('revokeConnection');
        return { count: 1 };
      },
    },
    calendarEventLink: {
      deleteMany: async (args: unknown) => {
        calls.push(`deleteLinks:${JSON.stringify(args)}`);
        if (opts.failLinkDelete) throw new Error('link delete failed');
        return { count: 2 };
      },
    },
  };
  const db = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
      const r = await fn(tx);
      committed = true;
      return r;
    },
  } as unknown as DatabaseClient;
  return { db, calls, updates, committed: () => committed };
}

function links(over: Partial<CalendarEventLinksRepository> = {}): CalendarEventLinksRepository {
  return {
    listForUser: async () => [],
    matchExternalIds: async () => new Map(),
    upsert: async () => null,
    remove: async () => false,
    removeForConnection: vi.fn(async () => undefined),
    ...over,
  };
}

describe('calendar disconnect: event -> meeting link cleanup', () => {
  it('Prisma revoke deletes the links inside the revoke transaction', async () => {
    const id = randomUUID();
    const f = fakeDb();
    expect(await new PrismaCalendarConnections(f.db).revoke(org, user, id)).toBe(true);
    expect(f.calls).toEqual([
      'revokeConnection',
      'purgeEvents',
      `deleteLinks:${JSON.stringify({ where: { organizationId: org, connectionId: id } })}`,
    ]);
    expect(f.committed()).toBe(true);
  });

  it('API token refresh only writes an ACTIVE row and never resurrects its status', async () => {
    const f = fakeDb();
    const id = randomUUID();
    const cipher = { encrypt: async (v: string) => `v1.k1.n.${v.length}`, decrypt: async () => '' };
    await new PrismaCalendarConnections(f.db, cipher as never).updateTokens(org, id, {
      accessToken: 'a',
      refreshToken: 'r',
      accessTokenExpiresAt: new Date(),
    });
    expect(f.updates[0]!.where).toEqual({ id, organizationId: org, status: 'active' });
    expect(f.updates[0]!.data).not.toHaveProperty('status');
  });

  it('Prisma revoke wipes the sync cursor and its window like a reconnect does', async () => {
    const f = fakeDb();
    expect(await new PrismaCalendarConnections(f.db).revoke(org, user, randomUUID())).toBe(true);
    expect(f.updates[0]!.data).toMatchObject({
      status: 'revoked',
      accessTokenEnc: null,
      refreshTokenEnc: null,
      syncCursorEnc: null,
      syncCursorFrom: null,
      syncCursorTo: null,
    });
  });

  it('a failed link delete rolls the revoke back instead of being swallowed', async () => {
    const f = fakeDb({ failLinkDelete: true });
    await expect(
      new PrismaCalendarConnections(f.db).revoke(org, user, randomUUID()),
    ).rejects.toThrow('link delete failed');
    expect(f.committed()).toBe(false);
  });

  it('with a transactional repository the service does not delete links a second time', async () => {
    const repo = new InMemoryCalendarConnections();
    const conn = await repo.upsert(org, {
      userId: user,
      provider: 'google',
      displayName: 'Me',
      externalAccountId: 'me@example.test',
      accessToken: 'a',
      refreshToken: 'r',
      accessTokenExpiresAt: new Date(Date.now() + 3600e3),
    });
    Object.assign(repo, { revokesLinks: true });
    const removeForConnection = vi.fn(async () => undefined);
    const l = links({ removeForConnection });
    const audit = vi.fn(async () => undefined);
    await new CalendarService(repo, undefined, undefined, undefined, l).disconnect(
      org,
      user,
      conn.id,
      audit,
    );
    expect(removeForConnection).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith('calendar.disconnect', conn.id, expect.anything());
  });

  it('with a non-transactional repository a link delete failure surfaces (not swallowed, no audit)', async () => {
    const repo = new InMemoryCalendarConnections();
    const conn = await repo.upsert(org, {
      userId: user,
      provider: 'google',
      displayName: 'Me',
      externalAccountId: 'me@example.test',
      accessToken: 'a',
      refreshToken: 'r',
      accessTokenExpiresAt: new Date(Date.now() + 3600e3),
    });
    const removeForConnection = vi.fn(async () => {
      throw new Error('links store down');
    });
    const l = links({ removeForConnection });
    const audit = vi.fn(async () => undefined);
    await expect(
      new CalendarService(repo, undefined, undefined, undefined, l).disconnect(
        org,
        user,
        conn.id,
        audit,
      ),
    ).rejects.toThrow('links store down');
    expect(removeForConnection).toHaveBeenCalledWith(org, conn.id);
    expect(audit).not.toHaveBeenCalled();
  });
});
