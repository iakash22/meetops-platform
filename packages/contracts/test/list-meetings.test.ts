import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { ListMeetingsQuery, ListMeetingsResponse } from '../src/index.js';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const t = '2026-10-31T10:00:00.000Z';

describe('list meetings contract', () => {
  it('query takes cursor, limit and a known source; rejects unknown sources and params', () => {
    expect(Value.Check(ListMeetingsQuery, {})).toBe(true);
    expect(Value.Check(ListMeetingsQuery, { source: 'desktop', limit: 10, cursor: 'abc' })).toBe(
      true,
    );
    expect(Value.Check(ListMeetingsQuery, { source: 'phone' })).toBe(false);
    expect(Value.Check(ListMeetingsQuery, { source: '' })).toBe(false);
    expect(Value.Check(ListMeetingsQuery, { organizationId: id(1) })).toBe(false);
    expect(Value.Check(ListMeetingsQuery, { limit: 0 })).toBe(false);
  });

  it('response is a cursor page of meetings', () => {
    const meeting = {
      id: id(1),
      organizationId: id(2),
      title: 'Standup',
      source: 'desktop',
      status: 'completed',
      createdById: null,
      createdAt: t,
      updatedAt: t,
    };
    expect(Value.Check(ListMeetingsResponse, { items: [meeting], nextCursor: null })).toBe(true);
    expect(Value.Check(ListMeetingsResponse, { items: [], nextCursor: 'c' })).toBe(true);
    expect(Value.Check(ListMeetingsResponse, { items: [meeting] })).toBe(false);
    expect(
      Value.Check(ListMeetingsResponse, { items: [{ ...meeting, source: 'x' }], nextCursor: null }),
    ).toBe(false);
  });
});
