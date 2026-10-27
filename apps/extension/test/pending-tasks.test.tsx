import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PopupView, type PopupViewProps } from '../entrypoints/popup/PopupView.js';
import {
  fetchPendingTasks,
  isPendingTasksRequest,
  pendingLabel,
  reviewUrl,
} from '../src/lib/pending-tasks.js';

const ORG = '00000000-0000-4000-8000-000000000001';
const noop = () => undefined;
const base: PopupViewProps = {
  auth: { state: 'paired', organizationId: ORG },
  status: { status: 'idle' },
  consent: { status: 'unconfirmed' },
  now: 0,
  error: '',
  onPair: noop,
  onUnpair: noop,
  onConsentChange: noop,
  onRecord: noop,
  onStop: noop,
  onDismissWarning: noop,
};
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('pending tasks', () => {
  it('reads the TASK_PATHS extracted-tasks page for the paired org', async () => {
    const apiFetch = vi.fn().mockResolvedValue(json(200, { items: [{}, {}], nextCursor: 'c' }));
    await expect(fetchPendingTasks(apiFetch, ORG)).resolves.toEqual({ count: 2, more: true });
    expect(apiFetch.mock.calls[0]?.[0]).toBe(`/orgs/${ORG}/extracted-tasks?limit=50`);
  });

  it('treats 404 as zero and throws on other errors', async () => {
    await expect(fetchPendingTasks(vi.fn().mockResolvedValue(json(404, {})), ORG)).resolves.toEqual(
      {
        count: 0,
        more: false,
      },
    );
    await expect(
      fetchPendingTasks(vi.fn().mockResolvedValue(json(500, {})), ORG),
    ).rejects.toThrow();
  });

  it('labels and links', () => {
    expect(pendingLabel({ count: 1, more: false })).toBe('1 task to review');
    expect(pendingLabel({ count: 50, more: true })).toBe('50+ tasks to review');
    expect(reviewUrl('https://app.meetops.ai')).toBe('https://app.meetops.ai/tasks/review');
    expect(isPendingTasksRequest({ target: 'background', type: 'TASKS_PENDING' })).toBe(true);
    expect(isPendingTasksRequest({ target: 'offscreen', type: 'TASKS_PENDING' })).toBe(false);
  });

  it('shows the compact row only when paired', () => {
    const p = { pendingTasks: { count: 3, more: false }, reviewHref: 'https://w/tasks/review' };
    const html = renderToStaticMarkup(<PopupView {...base} {...p} />);
    expect(html).toContain('3 tasks to review');
    expect(html).toContain('href="https://w/tasks/review"');
    expect(html).toContain('rel="noopener noreferrer"');
    const unpaired = renderToStaticMarkup(
      <PopupView {...base} {...p} auth={{ state: 'unpaired' }} />,
    );
    expect(unpaired).not.toContain('tasks to review');
  });
});
