import { describe, it, expect } from 'vitest';
import { toIntegrationIssue, fromIntegrationIssue, type Issue } from '../src';

const ctx = {
  id: '1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b',
  organizationId: '0b6f3a52-6a0e-4d1f-9c55-2f4c6f0e1a01',
  integrationId: '5f6e7d8c-9b0a-4c1d-8e2f-3a4b5c6d7e8f',
  taskId: '7d9e2c1b-3f4a-4b5c-8d6e-9f0a1b2c3d4e',
  now: new Date('2026-10-21T00:00:00Z')
};
const issue: Issue = { provider: 'jira', key: 'MEET-1', id: '10001', title: 'T', status: 'in_progress', url: 'https://acme.atlassian.net/browse/MEET-1', assignees: [], labels: [] };

describe('IntegrationIssueRecord mapping (contracts)', () => {
  it('maps a provider issue to a tenant-scoped record and back', () => {
    const rec = toIntegrationIssue(issue, ctx);
    expect(rec).toEqual({
      id: ctx.id,
      organizationId: ctx.organizationId,
      integrationId: ctx.integrationId,
      taskId: ctx.taskId,
      provider: 'jira',
      externalId: 'MEET-1',
      externalUrl: issue.url,
      lastKnownStatus: 'in_progress',
      syncedAt: '2026-10-21T00:00:00.000Z',
      createdAt: '2026-10-21T00:00:00.000Z'
    });
    expect(fromIntegrationIssue(rec)).toEqual({ organizationId: ctx.organizationId, integrationId: ctx.integrationId, provider: 'jira', key: 'MEET-1', lastKnownStatus: 'in_progress' });
  });
  it('omits non-https URLs and preserves createdAt', () => {
    const rec = toIntegrationIssue({ ...issue, provider: 'github', key: 'o/r#1', url: 'http://insecure.test/x' }, { ...ctx, createdAt: '2026-01-01T00:00:00.000Z' });
    expect(rec.externalUrl).toBeUndefined();
    expect(rec.createdAt).toBe('2026-01-01T00:00:00.000Z');
    expect(rec.provider).toBe('github');
  });
  it('rejects records that violate the contract (non-uuid ids)', () => {
    expect(() => toIntegrationIssue(issue, { ...ctx, organizationId: 'org_1' })).toThrow(/Invalid IntegrationIssueRecord/);
  });
});
