import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { readFileSync } from 'node:fs';
import {
  InitRecordingSessionParams,
  MEETING_INSIGHTS_PATHS,
  MeetingInsightsParams,
  MeetingReportResponse,
  MeetingTranscriptResponse,
  RECORDING_SESSION_PATHS,
  RecordingSessionParams,
  Report,
  TASK_PATHS,
  TaskParams,
  Transcript,
  UpdateTaskRequest,
} from '../src/index.js';
import * as light from '../src/types.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const id = '00000000-0000-4000-8000-000000000001';

describe('v0.8.0 package version', () => {
  it('is 0.8.x', () => expect(pkg.version).toMatch(/^0\.8\.\d+$/));
});

describe('v0.8.0 UpdateTaskRequest', () => {
  it('accepts partial updates and null clears', () => {
    for (const body of [
      { title: 'New title' },
      { status: 'done' },
      { priority: 'high' },
      { description: 'x' },
      { description: null, assigneeId: null, dueAt: null },
      { assigneeId: id, dueAt: '2026-11-01T10:00:00.000Z' },
    ])
      expect(Value.Check(UpdateTaskRequest, body), JSON.stringify(body)).toBe(true);
  });

  it('rejects empty, unknown keys, null on required fields and bad values', () => {
    for (const body of [
      {},
      { foo: 1 },
      { title: '' },
      { title: null },
      { status: null },
      { priority: null },
      { status: 'nope' },
      { assigneeId: 'not-a-uuid' },
      { dueAt: 'tomorrow' },
      { title: 'a'.repeat(501) },
      { description: 'a'.repeat(10_001) },
    ])
      expect(Value.Check(UpdateTaskRequest, body), JSON.stringify(body)).toBe(false);
  });

  it('lists Null first in each nullable union (Ajv coerceTypes safety)', () => {
    for (const k of ['description', 'assigneeId', 'dueAt'] as const) {
      const prop = UpdateTaskRequest.properties[k] as unknown as { anyOf: { type: string }[] };
      expect(prop.anyOf[0]?.type).toBe('null');
    }
  });

  it('TaskParams requires both uuids', () => {
    expect(Value.Check(TaskParams, { organizationId: id, taskId: id })).toBe(true);
    expect(Value.Check(TaskParams, { organizationId: id })).toBe(false);
  });
});

describe('v0.8.0 route constants', () => {
  it('pins the templates the API and apps use', () => {
    expect(RECORDING_SESSION_PATHS).toEqual({
      init: '/orgs/:organizationId/recording-sessions',
      chunks: '/recording-sessions/:sessionId/chunks',
      complete: '/recording-sessions/:sessionId/complete',
      abort: '/recording-sessions/:sessionId/abort',
    });
    expect(MEETING_INSIGHTS_PATHS).toEqual({
      transcript: '/orgs/:organizationId/meetings/:meetingId/transcript',
      report: '/orgs/:organizationId/meetings/:meetingId/report',
    });
    expect(TASK_PATHS).toEqual({
      tasks: '/orgs/:organizationId/tasks',
      extractedTasks: '/orgs/:organizationId/extracted-tasks',
      accept: '/orgs/:organizationId/extracted-tasks/:extractedTaskId/accept',
      dismiss: '/orgs/:organizationId/extracted-tasks/:extractedTaskId/dismiss',
      task: '/orgs/:organizationId/tasks/:taskId',
    });
  });

  it('are exported from the light types entry too', () => {
    expect(light.RECORDING_SESSION_PATHS).toBe(RECORDING_SESSION_PATHS);
    expect(light.MEETING_INSIGHTS_PATHS).toBe(MEETING_INSIGHTS_PATHS);
    expect(light.TASK_PATHS).toBe(TASK_PATHS);
  });

  it('params schemas match the path placeholders', () => {
    const keys = (t: string) => [...t.matchAll(/:([A-Za-z]+)/g)].map((m) => m[1]).sort();
    expect(Object.keys(InitRecordingSessionParams.properties).sort()).toEqual(
      keys(RECORDING_SESSION_PATHS.init),
    );
    for (const p of ['chunks', 'complete', 'abort'] as const)
      expect(Object.keys(RecordingSessionParams.properties).sort()).toEqual(
        keys(RECORDING_SESSION_PATHS[p]),
      );
    for (const p of ['transcript', 'report'] as const)
      expect(Object.keys(MeetingInsightsParams.properties).sort()).toEqual(
        keys(MEETING_INSIGHTS_PATHS[p]),
      );
    expect(Object.keys(TaskParams.properties).sort()).toEqual(keys(TASK_PATHS.task));
    expect(Value.Check(RecordingSessionParams, { sessionId: id, extra: 1 })).toBe(false);
    expect(Value.Check(MeetingInsightsParams, { organizationId: id, meetingId: 'x' })).toBe(false);
  });

  it('insights responses are the Transcript and Report DTOs', () => {
    expect(MeetingTranscriptResponse).toBe(Transcript);
    expect(MeetingReportResponse).toBe(Report);
  });
});
