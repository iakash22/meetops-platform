import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { AcceptExtractedTaskRequest, CreateTaskRequest } from '../src/index.js';

const ID = '00000000-0000-4000-8000-000000000001';

describe('v0.10.0 task request bodies', () => {
  it('CreateTaskRequest accepts minimal and full bodies and rejects bad ones', () => {
    expect(Value.Check(CreateTaskRequest, { title: 'x' })).toBe(true);
    expect(
      Value.Check(CreateTaskRequest, {
        title: 'x',
        description: 'd',
        status: 'in_progress',
        priority: 'high',
        assigneeId: ID,
        projectId: ID,
        meetingId: ID,
        dueAt: '2026-11-01T00:00:00.000Z',
      }),
    ).toBe(true);
    for (const bad of [
      {},
      { title: '' },
      { title: 'x', organizationId: ID },
      { title: 'x', assigneeId: null },
    ])
      expect(Value.Check(CreateTaskRequest, bad)).toBe(false);
  });
  it('AcceptExtractedTaskRequest requires title and priority', () => {
    expect(Value.Check(AcceptExtractedTaskRequest, { title: 'x', priority: 'low' })).toBe(true);
    expect(Value.Check(AcceptExtractedTaskRequest, { title: 'x' })).toBe(false);
    expect(Value.Check(AcceptExtractedTaskRequest, { title: 'x', priority: 'low', extra: 1 })).toBe(
      false,
    );
  });
});
