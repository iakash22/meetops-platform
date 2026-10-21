import { describe, it, expect } from 'vitest';
import { JiraIssueTrackerProvider, NotImplementedError } from '../src';

describe('JiraIssueTrackerProvider (stub)', () => {
  it('throws NotImplementedError for operations', async () => {
    const p = new JiraIssueTrackerProvider();
    await expect(p.createIssue({ title: 'x' })).rejects.toBeInstanceOf(NotImplementedError);
    await expect(p.updateStatus('P-1', 'done')).rejects.toBeInstanceOf(NotImplementedError);
    await expect(p.getIssue('P-1')).rejects.toBeInstanceOf(NotImplementedError);
    expect((await p.healthCheck()).ok).toBe(false);
  });
});
