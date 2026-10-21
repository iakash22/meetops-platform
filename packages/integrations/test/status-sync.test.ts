import { describe, it, expect } from 'vitest';
import { mapGitHubIssueEvent } from '../src';

const ev = (action: string, issue: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  action,
  issue: { number: 5, state: 'open', labels: [], ...issue },
  repository: { full_name: 'o/r' },
  ...extra
});

describe('mapGitHubIssueEvent', () => {
  it('maps opened/reopened', () => {
    expect(mapGitHubIssueEvent('issues', ev('opened'))).toEqual({ provider: 'github', key: 'o/r#5', status: 'open', action: 'opened' });
    expect(mapGitHubIssueEvent('issues', ev('reopened', { labels: [{ name: 'status: in-progress' }] }))?.status).toBe('in_progress');
  });
  it('maps closed by state_reason', () => {
    expect(mapGitHubIssueEvent('issues', ev('closed', { state: 'closed', state_reason: 'completed' }))?.status).toBe('done');
    expect(mapGitHubIssueEvent('issues', ev('closed', { state: 'closed', state_reason: 'not_planned' }))?.status).toBe('closed');
    expect(mapGitHubIssueEvent('issues', ev('closed', { state: 'closed', state_reason: null }))?.status).toBe('done');
  });
  it('maps in-progress label changes only', () => {
    expect(mapGitHubIssueEvent('issues', ev('labeled', {}, { label: { name: 'status: in-progress' } }))?.status).toBe('in_progress');
    expect(mapGitHubIssueEvent('issues', ev('unlabeled', {}, { label: { name: 'status: in-progress' } }))?.status).toBe('open');
    expect(mapGitHubIssueEvent('issues', ev('labeled', {}, { label: { name: 'bug' } }))).toBeNull();
    expect(mapGitHubIssueEvent('issues', ev('labeled', { state: 'closed' }, { label: { name: 'status: in-progress' } }))).toBeNull();
    expect(mapGitHubIssueEvent('issues', ev('labeled', {}, { label: { name: 'wip' } }), { inProgressLabel: 'wip' })?.status).toBe('in_progress');
  });
  it('ignores unknown events, actions and malformed payloads', () => {
    expect(mapGitHubIssueEvent('push', ev('opened'))).toBeNull();
    expect(mapGitHubIssueEvent('issues', ev('edited'))).toBeNull();
    expect(mapGitHubIssueEvent('issues', ev('assigned'))).toBeNull();
    expect(mapGitHubIssueEvent('issues', null)).toBeNull();
    expect(mapGitHubIssueEvent('issues', { action: 'opened' })).toBeNull();
  });
});
