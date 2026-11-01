import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { ListMeetingsQuery, Meeting, MeetingSource, ResolveMeetingRequest } from '../src/index.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('MeetingSource mobile', () => {
  it('accepts every source including mobile, rejects unknown values', () => {
    for (const s of ['upload', 'extension', 'desktop', 'bot', 'mobile'])
      expect(Value.Check(MeetingSource, s)).toBe(true);
    for (const s of ['tab', 'phone', 'Mobile', ''])
      expect(Value.Check(MeetingSource, s)).toBe(false);
  });

  it('ResolveMeetingRequest, Meeting and ListMeetingsQuery take mobile', () => {
    expect(
      Value.Check(ResolveMeetingRequest, {
        source: 'mobile',
        externalMeetingId: 'mobile:lq1x2y3-0123456789abcdef',
        title: 'Mobile recording',
        startedAt: '2026-10-31T10:00:00.000Z',
      }),
    ).toBe(true);
    const t = '2026-10-31T10:00:00.000Z';
    expect(
      Value.Check(Meeting, {
        id: id(1),
        organizationId: id(2),
        title: 'Mobile recording',
        source: 'mobile',
        status: 'recording',
        createdById: null,
        createdAt: t,
        updatedAt: t,
      }),
    ).toBe(true);
    expect(Value.Check(ListMeetingsQuery, { source: 'mobile' })).toBe(true);
  });
});
