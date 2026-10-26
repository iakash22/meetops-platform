import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { readFileSync } from 'node:fs';
import {
  CURRENT_CONSENT_VERSION,
  CursorPage,
  InitRecordingSessionRequest,
  ListMeetingsQuery,
  MEETING_PATHS,
  Meeting,
  RecordingSource,
} from '../src/index.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('v0.6.0 RecordingSource', () => {
  it('accepts tab, mobile and desktop only', () => {
    for (const s of ['tab', 'mobile', 'desktop'])
      expect(Value.Check(RecordingSource, s)).toBe(true);
    expect(Value.Check(RecordingSource, 'bot')).toBe(false);
  });
  it('InitRecordingSessionRequest takes a native source', () => {
    const body = {
      mimeType: 'audio/webm',
      startedAt: '2026-10-26T00:00:00.000Z',
      source: 'mobile',
      meetingId: id(1),
      consent: {
        consentVersion: CURRENT_CONSENT_VERSION,
        attestedAt: '2026-10-26T00:00:00.000Z',
        method: 'all_parties_notified',
      },
    };
    expect(Value.Check(InitRecordingSessionRequest, body)).toBe(true);
    expect(Value.Check(InitRecordingSessionRequest, { ...body, source: 'desktop' })).toBe(true);
    expect(Value.Check(InitRecordingSessionRequest, { ...body, source: 'upload' })).toBe(false);
  });
});

describe('v0.6.0 ListMeetingsQuery', () => {
  it('accepts cursor paging and filters, rejects unknown params', () => {
    expect(Value.Check(ListMeetingsQuery, {})).toBe(true);
    expect(
      Value.Check(ListMeetingsQuery, {
        cursor: 'abc',
        limit: 20,
        status: ['completed', 'failed'],
        source: 'desktop',
        q: 'standup',
      }),
    ).toBe(true);
    expect(
      Value.Check(ListMeetingsQuery, {
        status: 'processing',
        projectId: id(2),
        startedAfter: '2026-10-01T00:00:00.000Z',
      }),
    ).toBe(true);
    expect(Value.Check(ListMeetingsQuery, { foo: 1 })).toBe(false);
    expect(Value.Check(ListMeetingsQuery, { limit: 0 })).toBe(false);
    expect(Value.Check(ListMeetingsQuery, { status: [] })).toBe(false);
  });
  it('is a single object schema (no anyOf at the top level)', () => {
    expect((ListMeetingsQuery as { anyOf?: unknown }).anyOf).toBeUndefined();
  });
  it('response shape is CursorPage<Meeting>', () => {
    const m = {
      id: id(1),
      organizationId: id(2),
      title: 'Standup',
      source: 'desktop',
      status: 'completed',
      createdById: id(3),
      createdAt: '2026-10-26T00:00:00.000Z',
      updatedAt: '2026-10-26T00:00:00.000Z',
    };
    expect(Value.Check(CursorPage(Meeting), { items: [m], nextCursor: null })).toBe(true);
  });
  it('paths', () => {
    expect(MEETING_PATHS.meetings).toBe('/orgs/:organizationId/meetings');
    expect(MEETING_PATHS.meeting).toBe('/orgs/:organizationId/meetings/:meetingId');
  });
});

describe('package version', () => {
  it('is 0.6.0', () => expect(pkg.version).toBe('0.6.0'));
});
