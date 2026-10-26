import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtractedTask } from '@meetops/contracts';
import { ApiError } from '@/lib/api/client';
import { createTaskReviewApi } from '@/features/task-review/api';
import { confidenceLabel, validateTitle } from '@/features/task-review/review-page';
import { createMockApi, renderApp, resetStores } from './fixtures/render';
import { waitForRouteData } from './fixtures/route-ready';

const ORG = '00000000-0000-4000-8000-000000000001';
const T = '2026-10-20T11:00:00.000Z';
const item = (n: number, over: Partial<ExtractedTask> = {}): ExtractedTask => ({
  id: `40000000-0000-4000-8000-00000000000${n}`,
  meetingId: '20000000-0000-4000-8000-000000000001',
  reportId: '32000000-0000-4000-8000-000000000001',
  title: `Suggested ${n}`,
  confidence: 0.9,
  sourceSegmentIds: [],
  createdAt: T,
  ...over,
});

function routedRequest(handlers: Record<string, (body?: unknown) => unknown>) {
  return vi.fn(async (method: string, path: string, body?: unknown) => {
    const key = `${method} ${path.split('?')[0]}`;
    for (const [k, h] of Object.entries(handlers)) if (key === k) return h(body);
    if (method === 'GET' && path.includes('/tasks')) return { items: [], nextCursor: null };
    return undefined;
  });
}

function withRequest(request: ReturnType<typeof vi.fn>) {
  const api = createMockApi();
  return { ...api, request: request as typeof api.request };
}

describe('task review', () => {
  beforeEach(() => resetStores());

  it('helpers', () => {
    expect(confidenceLabel(0.42)).toEqual({ text: '42% confidence', low: true });
    expect(validateTitle('  ')).toBe('Enter a title.');
    expect(validateTitle('x'.repeat(501))).toMatch(/500/);
    expect(validateTitle('ok')).toBeNull();
  });

  it('builds encoded paths', async () => {
    const req = vi.fn().mockResolvedValue({});
    const api = createTaskReviewApi(req);
    await api.pending(ORG, { meetingId: 'm 1' });
    await api.accept(ORG, 'a/b', { title: 't', priority: 'low' });
    await api.dismiss(ORG, 'x');
    expect(req.mock.calls).toEqual([
      ['GET', `/orgs/${ORG}/extracted-tasks?meetingId=m+1`],
      ['POST', `/orgs/${ORG}/extracted-tasks/a%2Fb/accept`, { title: 't', priority: 'low' }],
      ['POST', `/orgs/${ORG}/extracted-tasks/x/dismiss`],
    ]);
  });

  it('still shows the empty state for a legacy 404', async () => {
    const request = vi.fn().mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'x'));
    renderApp('/tasks/review', withRequest(request));
    await waitForRouteData(request);
    expect(await screen.findByText('Nothing to review')).toBeInTheDocument();
  });

  it('accepts with edits, validates inline, and dismisses', async () => {
    const accepted = vi.fn((b: unknown) => ({ id: 't1', ...(b as object) }));
    const request = routedRequest({
      [`GET /orgs/${ORG}/extracted-tasks`]: () => ({
        items: [item(1, { assigneeHint: '<script>Ana</script>', confidence: 0.4 }), item(2)],
        nextCursor: null,
      }),
      [`POST /orgs/${ORG}/extracted-tasks/40000000-0000-4000-8000-000000000001/accept`]: accepted,
    });
    renderApp('/tasks/review', withRequest(request));
    await waitForRouteData(request);
    const form = await screen.findByRole('form', { name: 'Review Suggested 1' });
    expect(within(form).getByText('40% confidence')).toBeInTheDocument();
    expect(within(form).getByText('Suggested owner: <script>Ana</script>')).toBeInTheDocument();
    const title = within(form).getByLabelText('Title');
    await userEvent.clear(title);
    await userEvent.click(within(form).getByRole('button', { name: 'Accept' }));
    expect(await within(form).findByText('Enter a title.')).toBeInTheDocument();
    expect(title).toHaveAttribute('aria-invalid', 'true');
    expect(accepted).not.toHaveBeenCalled();
    await userEvent.type(title, 'Ship notes');
    await userEvent.selectOptions(within(form).getByLabelText('Priority'), 'high');
    await userEvent.click(within(form).getByRole('button', { name: 'Accept' }));
    await waitFor(() =>
      expect(accepted).toHaveBeenCalledWith({ title: 'Ship notes', priority: 'high' }),
    );
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Review Suggested 1' })).not.toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(await screen.findByText('Nothing to review')).toBeInTheDocument();
  });

  it('shows a toast when accepting fails', async () => {
    const request = routedRequest({
      [`GET /orgs/${ORG}/extracted-tasks`]: () => ({ items: [item(1)], nextCursor: null }),
      [`POST /orgs/${ORG}/extracted-tasks/40000000-0000-4000-8000-000000000001/accept`]: () => {
        throw new ApiError(500, 'INTERNAL', 'x');
      },
    });
    renderApp('/tasks/review', withRequest(request));
    await waitForRouteData(request);
    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    expect(await screen.findByText("Couldn't accept the task")).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Review Suggested 1' })).toBeInTheDocument();
  });

  it('shows the empty state for a 200 empty page', async () => {
    const request = routedRequest({
      [`GET /orgs/${ORG}/extracted-tasks`]: () => ({ items: [], nextCursor: null }),
    });
    renderApp('/tasks/review', withRequest(request));
    await waitForRouteData(request);
    expect(await screen.findByText('Nothing to review')).toBeInTheDocument();
  });

  it('treats a 409 as already reviewed: toast and drop the card', async () => {
    let listed = 0;
    const request = routedRequest({
      [`GET /orgs/${ORG}/extracted-tasks`]: () =>
        listed++ === 0 ? { items: [item(1)], nextCursor: null } : { items: [], nextCursor: null },
      [`POST /orgs/${ORG}/extracted-tasks/40000000-0000-4000-8000-000000000001/accept`]: () => {
        throw new ApiError(409, 'CONFLICT', 'x');
      },
    });
    renderApp('/tasks/review', withRequest(request));
    await waitForRouteData(request);
    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    expect(await screen.findByText('Task already reviewed')).toBeInTheDocument();
    expect(screen.queryByText("Couldn't accept the task")).not.toBeInTheDocument();
    expect(await screen.findByText('Nothing to review')).toBeInTheDocument();
  });
});
