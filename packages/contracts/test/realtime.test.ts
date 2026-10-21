import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  MeetingStatusEvent,
  REALTIME_EVENTS,
  RealtimeEvent,
  RealtimeEventSchemas,
  TaskUpdateEvent,
  TranscriptionProgressEvent,
  type RealtimeEventMap,
} from '../src/index.js';

const at = '2026-10-21T17:00:00.000Z';
const ids = { organizationId: 'o1', meetingId: 'm1' };

describe('realtime events', () => {
  it('maps event names to schemas', () => {
    expect(Object.values(REALTIME_EVENTS).sort()).toEqual(Object.keys(RealtimeEventSchemas).sort());
  });
  it('meeting:status uses contract statuses and organizationId', () => {
    expect(Value.Check(MeetingStatusEvent, { ...ids, status: 'processing', at })).toBe(true);
    expect(Value.Check(MeetingStatusEvent, { ...ids, status: 'transcribing', at })).toBe(false);
    expect(Value.Check(MeetingStatusEvent, { orgId: 'o1', meetingId: 'm1', status: 'completed', at })).toBe(false);
  });
  it('transcription:progress bounds percent', () => {
    expect(Value.Check(TranscriptionProgressEvent, { ...ids, percent: 42, stage: 'chunking', at })).toBe(true);
    expect(Value.Check(TranscriptionProgressEvent, { ...ids, percent: 101, at })).toBe(false);
  });
  it('task:update uses contract task statuses', () => {
    const e: RealtimeEventMap['task:update'] = { organizationId: 'o1', taskId: 't1', status: 'todo', at };
    expect(Value.Check(TaskUpdateEvent, e)).toBe(true);
    expect(Value.Check(TaskUpdateEvent, { ...e, status: 'open' })).toBe(false);
  });
  it('discriminated union checks payload against event name', () => {
    expect(Value.Check(RealtimeEvent, { event: 'meeting:status', data: { ...ids, status: 'failed', at } })).toBe(true);
    expect(Value.Check(RealtimeEvent, { event: 'task:update', data: { ...ids, status: 'failed', at } })).toBe(false);
  });
});
