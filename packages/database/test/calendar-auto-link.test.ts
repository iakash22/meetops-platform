import { describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { autoLinkInTx, canLinkMeetings, uniqueLiveMeetings } from '../src/calendar-sync.js';

const ORG = '00000000-0000-4000-8000-00000000000a';
const CONN = '00000000-0000-4000-8000-0000000000c1';
const USER = '00000000-0000-4000-8000-0000000000b1';
const mid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

type Meeting = { id: string; externalMeetingId: string | null };
type Member = { role: string; deletedAt: Date | null; userDeleted?: boolean };

/** In-memory stand-in for the org-scoped transaction client (Prisma semantics for the calls auto-link makes). */
function fakeTx(meetings: Meeting[], member: Member | null) {
  const inList = (w: { externalMeetingId: { in: string[] } }, m: Meeting) =>
    m.externalMeetingId !== null && w.externalMeetingId.in.includes(m.externalMeetingId);
  const inserted: { eventId: string; meetingId: string }[] = [];
  const tx = {
    membership: {
      findFirst: vi.fn(
        async (a: { where: { organizationId: string; userId: string; role: { in: string[] } } }) =>
          member &&
          a.where.organizationId === ORG &&
          a.where.userId === USER &&
          member.deletedAt === null &&
          !member.userDeleted &&
          a.where.role.in.includes(member.role)
            ? { id: 'mem' }
            : null,
      ),
    },
    meeting: {
      groupBy: vi.fn(async (a: { where: { externalMeetingId: { in: string[] } } }) => {
        const counts = new Map<string, number>();
        for (const m of meetings)
          if (inList(a.where, m))
            counts.set(m.externalMeetingId!, (counts.get(m.externalMeetingId!) ?? 0) + 1);
        return [...counts].map(([externalMeetingId, n]) => ({
          externalMeetingId,
          _count: { _all: n },
        }));
      }),
      findMany: vi.fn(
        async (a: { where: { externalMeetingId: { in: string[] } }; take?: number }) => {
          expect(a.take).toBeUndefined(); // never an arbitrary cap
          return meetings.filter((m) => inList(a.where, m));
        },
      ),
    },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      expect(strings.join('?')).toMatch(
        /FROM meetings m[\s\S]*m\.org_id[\s\S]*m\.deleted_at IS NULL/,
      );
      inserted.push({ eventId: values[4] as string, meetingId: values[5] as string });
      return [{ id: 'link' }];
    }),
    auditEvent: { createMany: vi.fn(async () => ({ count: 0 })) },
  };
  return { tx: tx as unknown as Prisma.TransactionClient, raw: tx, inserted };
}

describe('calendar auto-link matching (#398)', () => {
  it('matches every intended item with no cap, even when a busy id has many meetings', async () => {
    // The old `take: ext.length * 4` page (8 rows here) could be filled by the ambiguous id alone,
    // silently dropping the unique match for `solo`.
    const meetings: Meeting[] = [
      ...Array.from({ length: 12 }, (_, i) => ({ id: mid(100 + i), externalMeetingId: 'busy' })),
      { id: mid(1), externalMeetingId: 'solo' },
    ];
    const { tx, raw } = fakeTx(meetings, { role: 'member', deletedAt: null });
    const got = await uniqueLiveMeetings(tx, ORG, ['busy', 'solo']);
    expect([...got]).toEqual([['solo', mid(1)]]);
    expect(raw.meeting.findMany.mock.calls[0]![0].where.externalMeetingId.in).toEqual(['solo']);
  });

  it('links all unique matches across many candidates (no truncation)', async () => {
    const meetings: Meeting[] = Array.from({ length: 300 }, (_, i) => ({
      id: mid(i + 1),
      externalMeetingId: `x-${i}`,
    }));
    meetings.push({ id: mid(9999), externalMeetingId: 'x-0' }); // x-0 becomes ambiguous
    const { tx, inserted } = fakeTx(meetings, { role: 'member', deletedAt: null });
    const candidates = meetings.slice(0, 300).map((m, i) => ({
      eventId: `e-${i}`,
      externalMeetingId: m.externalMeetingId!,
    }));
    const n = await autoLinkInTx(
      tx,
      ORG,
      CONN,
      USER,
      candidates,
      new Set(candidates.map((c) => c.eventId)),
    );
    expect(n).toBe(299);
    expect(inserted.find((r) => r.eventId === 'e-0')).toBeUndefined();
    expect(inserted.find((r) => r.eventId === 'e-299')?.meetingId).toBe(mid(300));
  });

  it.each([
    ['owner', true],
    ['admin', true],
    ['member', true],
    ['viewer', false],
  ])('meeting-level access: role %s may link = %s', async (role, allowed) => {
    const { tx } = fakeTx([], { role, deletedAt: null });
    expect(await canLinkMeetings(tx, ORG, USER)).toBe(allowed);
  });

  it.each([
    ['a viewer', { role: 'viewer', deletedAt: null }],
    ['a removed member', { role: 'member', deletedAt: new Date() }],
    ['a deleted user', { role: 'member', deletedAt: null, userDeleted: true }],
    ['a non-member of the org', null],
  ] as const)('denied: no links (and no meeting lookup) for %s', async (_label, member) => {
    const { tx, raw, inserted } = fakeTx([{ id: mid(1), externalMeetingId: 'solo' }], member);
    const n = await autoLinkInTx(
      tx,
      ORG,
      CONN,
      USER,
      [{ eventId: 'e1', externalMeetingId: 'solo' }],
      new Set(['e1']),
    );
    expect(n).toBe(0);
    expect(inserted).toEqual([]);
    expect(raw.meeting.groupBy).not.toHaveBeenCalled();
    expect(raw.auditEvent.createMany).not.toHaveBeenCalled();
  });

  it('access is checked for the acting user in the acting org', async () => {
    const { tx, raw } = fakeTx([], { role: 'member', deletedAt: null });
    expect(await canLinkMeetings(tx, ORG, mid(77))).toBe(false);
    expect(await canLinkMeetings(tx, mid(78), USER)).toBe(false);
    expect(raw.membership.findFirst.mock.calls[0]![0].where).toMatchObject({
      organizationId: ORG,
      userId: mid(77),
      deletedAt: null,
      user: { deletedAt: null },
    });
  });
});
