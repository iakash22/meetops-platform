import { describe, it, expect } from 'vitest';
import { mapGitHubIssueEvent } from '../src';

const ctx = { organizationId: 'org_1', integrationId: 'int_1' };
const ev = (action: string, issue: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  action,
  issue: { number: 5, state: 'open', labels: [], ...issue },
  repository: { full_name: 'o/r' },
  ...extra
});
const map = (e: string, p: unknown, o?: { inProgressLabel?: string }) => mapGitHubIssueEvent(e, p, ctx, o);

describe('mapGitHubIssueEvent', () => {
  it('includes tenant + provider + externalId for lookup', () => {
    expect(map('issues', ev('opened'))).toEqual({ organizationId: 'org_1', integrationId: 'int_1', provider: 'github', externalId: 'o/r#5', status: 'open', action: 'opened' });
    expect(map('issues', ev('reopened', { labels: [{ name: 'status: in-progress' }] }))?.status).toBe('in_progress');
  });
  it('maps closed by state_reason', () => {
    expect(map('issues', ev('closed', { state: 'closed', state_reason: 'completed' }))?.status).toBe('done');
    expect(map('issues', ev('closed', { state: 'closed', state_reason: 'not_planned' }))?.status).toBe('closed');
    expect(map('issues', ev('closed', { state: 'closed', state_reason: null }))?.status).toBe('done');
  });
  it('maps in-progress label changes only', () => {
    expect(map('issues', ev('labeled', {}, { label: { name: 'status: in-progress' } }))?.status).toBe('in_progress');
    expect(map('issues', ev('unlabeled', {}, { label: { name: 'status: in-progress' } }))?.status).toBe('open');
    expect(map('issues', ev('labeled', {}, { label: { name: 'bug' } }))).toBeNull();
    expect(map('issues', ev('labeled', { state: 'closed' }, { label: { name: 'status: in-progress' } }))).toBeNull();
    expect(map('issues', ev('labeled', {}, { label: { name: 'wip' } }), { inProgressLabel: 'wip' })?.status).toBe('in_progress');
  });
  it('ignores unknown events, actions and malformed payloads', () => {
    expect(map('push', ev('opened'))).toBeNull();
    expect(map('issues', ev('edited'))).toBeNull();
    expect(map('issues', null)).toBeNull();
    expect(map('issues', { action: 'opened' })).toBeNull();
  });
});
