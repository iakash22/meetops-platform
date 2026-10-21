import { describe, it, expect } from 'vitest';
import { toIntegrationIssue, fromIntegrationIssue, type Issue } from '../src';

describe('IntegrationIssue mapping', () => {
  it('maps provider issue to link record and back', () => {
    const issue: Issue = { provider: 'jira', key: 'MEET-1', id: '10001', title: 'T', status: 'open', url: 'https://acme.atlassian.net/browse/MEET-1', assignees: [], labels: [] };
    const rec = toIntegrationIssue(issue, { id: 'ii_1', taskId: 'task_1', now: new Date('2026-10-21T00:00:00Z') });
    expect(rec).toEqual({ id: 'ii_1', taskId: 'task_1', integration: 'jira', externalId: 'MEET-1', externalUrl: issue.url, syncedAt: '2026-10-21T00:00:00.000Z', createdAt: '2026-10-21T00:00:00.000Z' });
    expect(fromIntegrationIssue(rec)).toEqual({ provider: 'jira', key: 'MEET-1' });
  });
});
