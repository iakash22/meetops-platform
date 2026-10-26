import { describe, expect, it } from 'vitest';
import type { DatabaseClient } from '@meetops/database';
import { createPrismaSessionStore } from '../src/index.js';

const ORG = '11111111-1111-4111-8111-111111111111';
const USER = '33333333-3333-4333-8333-333333333333';

/** Minimal fake of the Prisma surface the store touches; records the order of calls. */
function fakeClient() {
  const log: string[] = [];
  const tx = {
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      log.push(`set_config ${String(values[0])}=${String(values[1])}`);
      void strings;
      return 1;
    },
    membership: {
      findFirst: async (args: unknown) => {
        log.push(`membership.findFirst ${JSON.stringify(args)}`);
        return { role: 'member', deletedAt: null };
      },
    },
  };
  const client = {
    $transaction: async (fn: (t: typeof tx) => Promise<unknown>) => {
      log.push('begin');
      const r = await fn(tx);
      log.push('commit');
      return r;
    },
    session: {
      findUnique: async (args: unknown) => {
        log.push(`session.findUnique ${JSON.stringify(args)}`);
        return {
          id: 's1',
          userId: USER,
          activeOrgId: ORG,
          expiresAt: new Date(2),
          absoluteExpiresAt: new Date(3),
          lastSeenAt: new Date(1),
          revokedAt: null,
          user: { deletedAt: null },
        };
      },
    },
  };
  return { client: client as unknown as DatabaseClient, log };
}

describe('createPrismaSessionStore', () => {
  it('maps the sessions row (expires_at = idle, absolute_expires_at = hard cap) and never writes', async () => {
    const { client, log } = fakeClient();
    const s = await createPrismaSessionStore(client).findSessionByTokenHash('h');
    expect(s).toEqual({
      id: 's1',
      userId: USER,
      activeOrganizationId: ORG,
      idleExpiresAt: new Date(2),
      absoluteExpiresAt: new Date(3),
      lastSeenAt: new Date(1),
      revokedAt: null,
      userDeletedAt: null,
    });
    expect(log).toHaveLength(1);
    expect(log[0]).toContain('"tokenHash":"h"');
  });

  it('reads the membership inside withOrganizationContext (org context set before the read)', async () => {
    const { client, log } = fakeClient();
    expect(await createPrismaSessionStore(client).findMembership(ORG, USER)).toEqual({
      role: 'member',
      deletedAt: null,
    });
    expect(log[0]).toBe('begin');
    expect(log.slice(1, 3).every((l) => l.startsWith('set_config') && l.endsWith(`=${ORG}`))).toBe(
      true,
    );
    expect(log.some((l) => l.startsWith('set_config') && l.endsWith(`=${USER}`))).toBe(true);
    const read = log.find((l) => l.startsWith('membership.findFirst'))!;
    const lastSet = log.map((l) => l.startsWith('set_config')).lastIndexOf(true);
    expect(log.indexOf(read)).toBeGreaterThan(lastSet);
    expect(JSON.parse(read.slice('membership.findFirst '.length))).toMatchObject({
      where: { organizationId: ORG, userId: USER, deletedAt: null },
    });
    expect(log.at(-1)).toBe('commit');
  });

  it('rejects a non-UUID organization id before any query', async () => {
    const { client, log } = fakeClient();
    await expect(
      createPrismaSessionStore(client).findMembership('not-a-uuid', USER),
    ).rejects.toThrow();
    expect(log).toEqual([]);
  });
});
