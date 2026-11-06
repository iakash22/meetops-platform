import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ExtractedTask } from '@meetops/contracts';
import { ApiError } from '@/lib/api/client';
import { TASK_PATHS, createTaskReviewApi } from '@/features/task-review/api';
import {
  buildUpdate,
  serverFieldErrors,
  validateEdit,
} from '@/features/task-review/edit-task-form';
import type { Task } from '@meetops/contracts';
import { confidenceLabel, validateTitle } from '@/features/task-review/review-page';
import { createMockApi, renderApp, resetStores } from './fixtures/render';
import { waitForRouteData } from './fixtures/route-ready';
import { chooseSelect } from './fixtures/select';

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
    await api.update(ORG, 't 1', { title: 'n' });
    expect(req.mock.calls).toEqual([
      ['GET', `/orgs/${ORG}/extracted-tasks?meetingId=m+1`],
      ['POST', `/orgs/${ORG}/extracted-tasks/a%2Fb/accept`, { title: 't', priority: 'low' }],
      ['POST', `/orgs/${ORG}/extracted-tasks/x/dismiss`],
      ['PATCH', `/orgs/${ORG}/tasks/t%201`, { title: 'n' }],
    ]);
    expect(TASK_PATHS.task).toBe('/orgs/:organizationId/tasks/:taskId');
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
    await chooseSelect('Priority', 'High', form);
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

  it('edit helpers send only changed keys and null to clear', () => {
    const t: Task = {
      id: 't1',
      organizationId: ORG,
      title: 'A',
      description: 'd',
      status: 'todo',
      priority: 'medium',
      dueAt: '2026-11-01T00:00:00.000Z',
      createdAt: T,
      updatedAt: T,
    };
    const base = {
      title: 'A',
      description: 'd',
      priority: 'medium',
      status: 'todo',
      due: '2026-11-01',
    } as const;
    expect(buildUpdate(t, base)).toEqual({});
    expect(
      buildUpdate(t, { ...base, title: ' B ', description: '', due: '', status: 'done' }),
    ).toEqual({
      title: 'B',
      description: null,
      dueAt: null,
      status: 'done',
    });
    expect(buildUpdate({ ...t, dueAt: '' }, { ...base, due: '2026-12-05' }).dueAt).toBe(
      '2026-12-05T00:00:00.000Z',
    );
    expect(validateEdit({ ...base, title: '' })).toEqual({ title: 'Enter a title.' });
    expect(
      serverFieldErrors(
        new ApiError(422, 'VALIDATION_FAILED', 'x', undefined, [{ path: '/dueAt', message: 'm' }]),
      ),
    ).toEqual({ dueAt: 'Enter a valid date.' });
    expect(serverFieldErrors(new ApiError(500, 'INTERNAL', 'x'))).toBeNull();
  });

  it('edits an accepted task: inline server error, then saves the patch', async () => {
    const created: Task = {
      id: '50000000-0000-4000-8000-000000000001',
      organizationId: ORG,
      title: 'Suggested 1',
      status: 'todo',
      priority: 'medium',
      createdAt: T,
      updatedAt: T,
    };
    let patches = 0;
    const patch = vi.fn((b: unknown) => {
      if (patches++ === 0)
        throw new ApiError(422, 'VALIDATION_FAILED', 'x', undefined, [
          { path: '/title', message: 'm' },
        ]);
      return { ...created, ...(b as object) };
    });
    const request = routedRequest({
      [`GET /orgs/${ORG}/extracted-tasks`]: () => ({ items: [item(1)], nextCursor: null }),
      [`POST /orgs/${ORG}/extracted-tasks/40000000-0000-4000-8000-000000000001/accept`]: () =>
        created,
      [`PATCH /orgs/${ORG}/tasks/${created.id}`]: patch,
    });
    renderApp('/tasks/review', withRequest(request));
    await waitForRouteData(request);
    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Suggested 1' }));
    const form = await screen.findByRole('form', { name: 'Edit task' });
    const title = within(form).getByLabelText('Title');
    await userEvent.clear(title);
    await userEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(await within(form).findByText('Enter a title.')).toBeInTheDocument();
    expect(patch).not.toHaveBeenCalled();
    await userEvent.type(title, 'Bad');
    await userEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(await within(form).findByText('Enter a valid title.')).toBeInTheDocument();
    expect(title).toHaveAttribute('aria-invalid', 'true');
    await userEvent.clear(title);
    await userEvent.type(title, 'Ship it');
    await chooseSelect('Priority', 'Urgent', form);
    await userEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(patch).toHaveBeenLastCalledWith({ title: 'Ship it', priority: 'urgent' }),
    );
    expect(await screen.findByText('Task updated')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Edit task' })).not.toBeInTheDocument(),
    );
  });

  it('toasts a non-field edit error', async () => {
    const created: Task = {
      id: '50000000-0000-4000-8000-000000000002',
      organizationId: ORG,
      title: 'Suggested 1',
      status: 'todo',
      priority: 'medium',
      createdAt: T,
      updatedAt: T,
    };
    const request = routedRequest({
      [`GET /orgs/${ORG}/extracted-tasks`]: () => ({ items: [item(1)], nextCursor: null }),
      [`POST /orgs/${ORG}/extracted-tasks/40000000-0000-4000-8000-000000000001/accept`]: () =>
        created,
      [`PATCH /orgs/${ORG}/tasks/${created.id}`]: () => {
        throw new ApiError(500, 'INTERNAL', 'x');
      },
    });
    renderApp('/tasks/review', withRequest(request));
    await waitForRouteData(request);
    await userEvent.click(await screen.findByRole('button', { name: 'Accept' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Suggested 1' }));
    const form = await screen.findByRole('form', { name: 'Edit task' });
    await chooseSelect('Status', 'Done', form);
    await userEvent.click(within(form).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText("Couldn't update the task")).toBeInTheDocument();
  });
});
