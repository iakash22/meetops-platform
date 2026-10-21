import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskUpdateEvent } from '@meetops/contracts';
import { applyTaskUpdate } from '@/lib/api/queries';
import { parseTaskSearch } from '@/features/tasks/tasks-page';
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
      expect(api.tasks.list).toHaveBeenCalledWith('org_1', {
        status: 'done',
        due: 'overdue',
        assigneeId: 'usr_1',
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
      expect(api.tasks.list).toHaveBeenLastCalledWith('org_1', {
        status: 'cancelled',
        due: 'week',
      }),
    );
    await userEvent.selectOptions(screen.getByLabelText('Status'), '');
    await waitFor(() => expect(history.location.search).not.toContain('status='));
  });

  it('drops unknown or malformed filter values', () => {
    expect(parseTaskSearch({ status: 'hacked', assignee: '<x>', due: 'never' })).toEqual({});
    expect(parseTaskSearch({ status: 'todo', assignee: 'usr_9', due: 'today' })).toEqual({
      status: 'todo',
      assignee: 'usr_9',
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
      organizationId: 'org_1',
      taskId: 'tsk_1',
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
