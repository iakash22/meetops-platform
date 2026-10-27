import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { readFileSync } from 'node:fs';
import { NotificationNewEvent, REALTIME_EVENTS, SummaryReadyEvent } from '../src/index.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};
const ORG = '11111111-1111-4111-8111-111111111111';
const ID = '22222222-2222-4222-8222-222222222222';

describe('v0.13.0 realtime events', () => {
  it('is 0.13.0 or later', () => expect(pkg.version).toMatch(/^0\.(1[3-9]|[2-9]\d)\.\d+$/));
  it('names', () => {
    expect(REALTIME_EVENTS.summaryReady).toBe('summary:ready');
    expect(REALTIME_EVENTS.notificationNew).toBe('notification:new');
  });
  it('summary:ready is ids/counts only', () => {
    const ok = {
      organizationId: ORG,
      meetingId: ID,
      reportId: ID,
      transcriptRevision: 2,
      tasksPendingReview: 1,
      at: '2026-10-28T00:00:00.000Z',
    };
    expect(Value.Check(SummaryReadyEvent, ok)).toBe(true);
    expect(Value.Check(SummaryReadyEvent, { ...ok, summary: 'text' })).toBe(false);
    expect(Value.Check(SummaryReadyEvent, { ...ok, tasksPendingReview: -1 })).toBe(false);
  });
  it('notification:new carries no title/body', () => {
    const ok = {
      organizationId: ORG,
      notificationId: ID,
      kind: 'tasks.ready_for_review',
      at: '2026-10-28T00:00:00.000Z',
    };
    expect(Value.Check(NotificationNewEvent, ok)).toBe(true);
    expect(Value.Check(NotificationNewEvent, { ...ok, title: 'x' })).toBe(false);
  });
});
