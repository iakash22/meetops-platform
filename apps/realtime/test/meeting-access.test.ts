import { describe, expect, it } from 'vitest';
import type { DatabaseClient } from '@meetops/database';
import { createPrismaMeetingAccess } from '../src/meeting-access.js';
import { MEETING_A, ORG_A } from './fixtures.js';

const USER = '33333333-3333-4333-8333-333333333333';

/** Minimal fake of the Prisma surface used; records the order of calls (same approach as session-verifier). */
function fakeClient(row: { id: string } | null | Error) {
  const log: string[] = [];
  const tx = {
    $executeRaw: async (_s: TemplateStringsArray, ...values: unknown[]) => (
      log.push(`set_config ${String(values[0])}=${String(values[1])}`),
      1
    ),
    meeting: {
      findFirst: async (args: unknown) => {
        log.push(`meeting.findFirst ${JSON.stringify(args)}`);
        if (row instanceof Error) throw row;
        return row;
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
  };
  return { log, client: client as unknown as DatabaseClient };
}

describe('createPrismaMeetingAccess (ADR-011 section 4.1)', () => {
  it('looks the meeting up under the socket org context, excluding deleted rows', async () => {
    const { log, client } = fakeClient({ id: MEETING_A });
    expect(
      await createPrismaMeetingAccess(client)({
        organizationId: ORG_A,
        userId: USER,
        meetingId: MEETING_A,
      }),
    ).toBe(true);
    expect(log[0]).toBe('begin');
    expect(log).toContain(`set_config app.current_organization_id=${ORG_A}`);
    expect(log).toContain(`set_config app.current_user_id=${USER}`);
    expect(log).toContain(
      `meeting.findFirst ${JSON.stringify({ where: { id: MEETING_A, organizationId: ORG_A, deletedAt: null }, select: { id: true } })}`,
    );
    expect(log.at(-1)).toBe('commit');
  });

  it('returns false when no row is visible (missing, deleted or other org)', async () => {
    const { client } = fakeClient(null);
    expect(
      await createPrismaMeetingAccess(client)({
        organizationId: ORG_A,
        userId: USER,
        meetingId: MEETING_A,
      }),
    ).toBe(false);
  });

  it('returns false without a query for non-UUID ids', async () => {
    const { log, client } = fakeClient({ id: 'x' });
    const access = createPrismaMeetingAccess(client);
    expect(await access({ organizationId: ORG_A, userId: USER, meetingId: 'mA' })).toBe(false);
    expect(await access({ organizationId: 'orgA', userId: USER, meetingId: MEETING_A })).toBe(
      false,
    );
    expect(log).toEqual([]);
  });

  it('propagates DB errors so the server fails closed', async () => {
    const { client } = fakeClient(new Error('db down'));
    await expect(
      createPrismaMeetingAccess(client)({
        organizationId: ORG_A,
        userId: USER,
        meetingId: MEETING_A,
      }),
    ).rejects.toThrow('db down');
  });
});
