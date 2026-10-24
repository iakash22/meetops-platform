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
const ids = { organizationId: 'f1584b99-5a47-4098-8ad7-5bb8d29e9734', meetingId: 'ae7be26c-daa7-42ca-8480-68d5ac90eaca' };

describe('realtime events', () => {
  it('maps event names to schemas', () => {
    expect(Object.values(REALTIME_EVENTS).sort()).toEqual(Object.keys(RealtimeEventSchemas).sort());
  });
  it('meeting:status uses contract statuses and organizationId', () => {
    expect(Value.Check(MeetingStatusEvent, { ...ids, status: 'processing', at })).toBe(true);
    expect(Value.Check(MeetingStatusEvent, { ...ids, status: 'transcribing', at })).toBe(false);
    expect(Value.Check(MeetingStatusEvent, { orgId: 'f1584b99-5a47-4098-8ad7-5bb8d29e9734', meetingId: 'ae7be26c-daa7-42ca-8480-68d5ac90eaca', status: 'completed', at })).toBe(false);
  });
  it('transcription:progress bounds percent', () => {
    expect(Value.Check(TranscriptionProgressEvent, { ...ids, percent: 42, stage: 'chunking', at })).toBe(true);
    expect(Value.Check(TranscriptionProgressEvent, { ...ids, percent: 101, at })).toBe(false);
  });
  it('task:update uses contract task statuses', () => {
    const e: RealtimeEventMap['task:update'] = { organizationId: 'f1584b99-5a47-4098-8ad7-5bb8d29e9734', taskId: '83f1535f-99ab-4bf4-89d0-2dfd85d3e3f7', status: 'todo', at };
    expect(Value.Check(TaskUpdateEvent, e)).toBe(true);
    expect(Value.Check(TaskUpdateEvent, { ...e, status: 'open' })).toBe(false);
  });
  it('discriminated union checks payload against event name', () => {
    expect(Value.Check(RealtimeEvent, { event: 'meeting:status', data: { ...ids, status: 'failed', at } })).toBe(true);
    expect(Value.Check(RealtimeEvent, { event: 'task:update', data: { ...ids, status: 'failed', at } })).toBe(false);
  });
});
