import { describe, expect, it, vi } from 'vitest';
import type { CalendarSyncEventInput } from '@meetops/database';
import {
  autoLinkCandidates,
  loadCalendarSyncEnv,
  runCalendarSyncSweep,
  type CalendarSyncSweepRepository,
} from '../src/calendar/index.js';

const ORG = '00000000-0000-4000-8000-00000000000a';
const C1 = '00000000-0000-4000-8000-0000000000c1';
const USER = '00000000-0000-4000-8000-0000000000b1';
const NOW = Date.parse('2026-10-31T10:00:00Z');
const LEASE = new Date(NOW + 600_000);

const ev = (id: string, over: Partial<CalendarSyncEventInput> = {}): CalendarSyncEventInput => ({
  id,
  title: `t-${id}`,
  startsAt: '2026-11-01T09:00:00.000Z',
  endsAt: '2026-11-01T10:00:00.000Z',
  allDay: false,
  attendeeCount: 1,
  status: 'confirmed',
  ...over,
});

function makeRepo(autoLinked = 0) {
  const applied: Parameters<CalendarSyncSweepRepository['applySync']>[1][] = [];
  const applySync = vi.fn<CalendarSyncSweepRepository['applySync']>(async (_o, input) => {
    applied.push(input);
    return { upserted: input.events.length, cancelled: 0, applied: true, autoLinked };
  });
  const repo: CalendarSyncSweepRepository = {
    listDueForSync: vi.fn(async () => [
      { organizationId: ORG, id: C1, userId: USER, provider: 'google' },
    ]),
    claimForSync: vi.fn(async () => ({ lease: LEASE })),
    readSecrets: vi.fn(async () => ({
      userId: USER,
      provider: 'google',
      accessToken: 'access-placeholder',
      refreshToken: null,
      accessTokenExpiresAt: new Date(NOW + 3_600_000),
      syncFailures: 0,
      syncCursor: null,
    })),
    updateTokens: vi.fn(async () => undefined),
    markError: vi.fn(async () => undefined),
    recordFailure: vi.fn(async () => true),
    applySync,
  };
  return { repo, applied };
}

const events = [
  ev('meet', { conferenceUrl: 'https://meet.google.com/abc-defg-hij?authuser=0' }),
  ev('zoom', { conferenceUrl: 'https://us02web.zoom.us/j/123456789?pwd=x' }),
  ev('cancelled', { status: 'cancelled', conferenceUrl: 'https://meet.google.com/zzz-zzzz-zzz' }),
  ev('other-host', { conferenceUrl: 'https://example.com/call/1' }),
  ev('http', { conferenceUrl: 'http://meet.google.com/abc-defg-hij' }),
  ev('none'),
];

describe('calendar auto-link (worker)', () => {
  it('derives candidates only for live events on supported meeting hosts', () => {
    expect(autoLinkCandidates(events)).toEqual([
      { eventId: 'meet', externalMeetingId: 'meet.google.com/abc-defg-hij' },
      { eventId: 'zoom', externalMeetingId: 'us02web.zoom.us/j/123456789' },
    ]);
  });

  it('is off by default: the sweep sends no candidates', async () => {
    const { repo, applied } = makeRepo();
    const r = await runCalendarSyncSweep({
      repo,
      providers: { google: { refresh: vi.fn(), listEvents: vi.fn(async () => events) } },
      log: { info: vi.fn(), warn: vi.fn() },
      now: () => NOW,
      random: () => 0,
    });
    expect(applied[0]).not.toHaveProperty('autoLink');
    expect(r.autoLinked).toBe(0);
    expect(loadCalendarSyncEnv({}).config.autoLinkEnabled).toBe(false);
    expect(loadCalendarSyncEnv({ CALENDAR_AUTO_LINK_ENABLED: 'yes' }).config.autoLinkEnabled).toBe(
      false,
    );
  });

  it('when enabled, passes candidates into the lease-guarded applySync and counts links', async () => {
    const { repo, applied } = makeRepo(2);
    const r = await runCalendarSyncSweep({
      repo,
      providers: { google: { refresh: vi.fn(), listEvents: vi.fn(async () => events) } },
      log: { info: vi.fn(), warn: vi.fn() },
      config: loadCalendarSyncEnv({ CALENDAR_AUTO_LINK_ENABLED: ' TRUE ' }).config,
      now: () => NOW,
      random: () => 0,
    });
    expect(applied[0]?.lease).toEqual(LEASE);
    expect(applied[0]?.autoLink).toEqual(autoLinkCandidates(events));
    expect(r).toMatchObject({ synced: 1, autoLinked: 2 });
  });
});
