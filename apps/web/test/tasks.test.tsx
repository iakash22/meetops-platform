import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskUpdateEvent } from '@meetops/contracts';
import { applyTaskUpdate } from '@/lib/api/queries';
import { dueRange, parseTaskSearch, toApiFilters } from '@/features/tasks/tasks-page';
import { task1 } from './fixtures/data';
import { createMockApi, renderApp, resetStores } from './fixtures/render';

const XSS = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';

describe('tasks', () => {
  beforeEach(() => resetStores());

  it('lists tasks including cancelled status and priority', async () => {
    renderApp('/tasks');
    expect(await screen.findByText('Send recap')).toBeInTheDocument();
    expect(within(screen.getByRole('list')).getByText('Cancelled')).toBeInTheDocument();
    expect(screen.getByText('medium')).toBeInTheDocument();
  });

  it('reads filters from the URL and passes them to the api', async () => {
    const { api } = renderApp('/tasks?status=done&assignee=me&due=overdue');
    await screen.findByRole('heading', { name: 'Tasks' });
    await waitFor(() =>
      expect(api.tasks.list).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', {
        status: 'done',
        dueBefore: expect.any(String),
        assigneeId: '10000000-0000-4000-8000-000000000001',
      }),
    );
    expect(screen.getByLabelText('Status')).toHaveValue('done');
    expect(screen.getByLabelText('Assignee')).toHaveValue('me');
    expect(screen.getByLabelText('Due')).toHaveValue('overdue');
  });

  it('writes filter changes to URL search params', async () => {
    const { history, api } = renderApp('/tasks');
    await screen.findByText('Send recap');
    await userEvent.selectOptions(screen.getByLabelText('Status'), 'cancelled');
    await waitFor(() => expect(history.location.search).toContain('status=cancelled'));
    await userEvent.selectOptions(screen.getByLabelText('Due'), 'week');
    await waitFor(() => expect(history.location.search).toContain('due=week'));
    await waitFor(() =>
      expect(api.tasks.list).toHaveBeenLastCalledWith('00000000-0000-4000-8000-000000000001', {
        status: 'cancelled',
        dueAfter: expect.any(String),
        dueBefore: expect.any(String),
      }),
    );
    await userEvent.selectOptions(screen.getByLabelText('Status'), '');
    await waitFor(() => expect(history.location.search).not.toContain('status='));
  });

  it('Unassigned sends unassigned=true and never assigneeId', async () => {
    const { api } = renderApp('/tasks');
    await screen.findByText('Send recap');
    await userEvent.selectOptions(screen.getByLabelText('Assignee'), 'unassigned');
    await waitFor(() =>
      expect(api.tasks.list).toHaveBeenLastCalledWith('00000000-0000-4000-8000-000000000001', {
        unassigned: true,
      }),
    );
  });

  it('maps filters to ListTasksQuery', () => {
    const now = new Date(2026, 9, 22, 13, 43);
    expect(toApiFilters({ assignee: 'me' }, '10000000-0000-4000-8000-000000000001', now)).toEqual({
      assigneeId: '10000000-0000-4000-8000-000000000001',
    });
    expect(toApiFilters({ assignee: 'me' }, undefined, now)).toEqual({});
    expect(
      toApiFilters(
        { assignee: 'unassigned', status: 'todo' },
        '10000000-0000-4000-8000-000000000001',
        now,
      ),
    ).toEqual({
      status: 'todo',
      unassigned: true,
    });
    expect(toApiFilters({ due: 'overdue' }, undefined, now)).toEqual({
      dueBefore: now.toISOString(),
    });
  });

  it('due ranges use local time; this week runs from now to the end of Sunday (Mon-start weeks)', () => {
    const thu = new Date(2026, 9, 22, 13, 43);
    expect(dueRange('today', thu)).toEqual({
      dueAfter: new Date(2026, 9, 22, 0, 0, 0, 0).toISOString(),
      dueBefore: new Date(2026, 9, 22, 23, 59, 59, 999).toISOString(),
    });
    expect(dueRange('week', thu)).toEqual({
      dueAfter: thu.toISOString(),
      dueBefore: new Date(2026, 9, 25, 23, 59, 59, 999).toISOString(),
    });
    const sun = new Date(2026, 9, 25, 10, 0);
    expect(dueRange('week', sun).dueBefore).toBe(
      new Date(2026, 9, 25, 23, 59, 59, 999).toISOString(),
    );
    const mon = new Date(2026, 9, 26, 9, 0);
    expect(dueRange('week', mon).dueBefore).toBe(
      new Date(2026, 10, 1, 23, 59, 59, 999).toISOString(),
    );
  });

  it('drops unknown or malformed filter values', () => {
    expect(parseTaskSearch({ status: 'hacked', assignee: '<x>', due: 'never' })).toEqual({});
    expect(
      parseTaskSearch({
        status: 'todo',
        assignee: '10000000-0000-4000-8000-000000000009',
        due: 'today',
      }),
    ).toEqual({
      status: 'todo',
      assignee: '10000000-0000-4000-8000-000000000009',
      due: 'today',
    });
  });

  it('renders HTML in task titles as escaped text (api)', async () => {
    renderApp(
      '/tasks',
      createMockApi({
        tasks: {
          list: vi.fn().mockResolvedValue({ items: [{ ...task1, title: XSS }], nextCursor: null }),
        },
      }),
    );
    const title = await screen.findByTestId('task-title');
    expect(title).toHaveTextContent(XSS);
    expect(title.querySelector('img,script')).toBeNull();
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });

  it('renders HTML in realtime task title updates as escaped text', async () => {
    const { queryClient } = renderApp('/tasks');
    await screen.findByText('Send recap');
    const event: TaskUpdateEvent = {
      organizationId: '00000000-0000-4000-8000-000000000001',
      taskId: '30000000-0000-4000-8000-000000000001',
      status: 'in_progress',
      title: XSS,
      at: '2026-10-21T10:00:00.000Z',
    };
    act(() => applyTaskUpdate(queryClient, event));
    const titles = await screen.findAllByTestId('task-title');
    const updated = titles.find((t) => t.textContent === XSS);
    expect(updated).toBeDefined();
    expect(
      document.querySelector('[data-testid="task-title"] img, [data-testid="task-title"] script'),
    ).toBeNull();
    expect(within(screen.getByRole('list')).getByText('In progress')).toBeInTheDocument();
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });
});
