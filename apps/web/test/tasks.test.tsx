import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskUpdateEvent } from '@meetops/contracts';
import { applyTaskUpdate, isIsoDateTime } from '@/lib/api/queries';
import { dueRange, parseTaskSearch, toApiFilters } from '@/features/tasks/tasks-page';
import { task1 } from './fixtures/data';
import { createMockApi, renderApp, resetStores } from './fixtures/render';

const XSS = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';

describe('tasks', () => {
  beforeEach(() => resetStores());

  it('lists tasks including cancelled status and priority', async () => {
    const { api } = renderApp('/tasks');
    // Await each deterministic milestone instead of one findBy spanning the whole
    // cold-start chain (guard beforeLoad -> session -> shell -> tasks query), which
    // could exceed findBy's default timeout on a loaded CI runner.
    await screen.findByRole('heading', { name: 'Tasks' });
    await waitFor(() => expect(api.tasks.list).toHaveBeenCalled());
    const listMock = vi.mocked(api.tasks.list);
    await act(async () => {
      await listMock.mock.results[0]?.value;
    });
    const list = await screen.findByRole('list');
    expect(within(list).getByText('Send recap')).toBeInTheDocument();
    expect(within(list).getByText('Cancelled')).toBeInTheDocument();
    expect(within(list).getByText('medium')).toBeInTheDocument();
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
    for (const bad of ['usr_9', 'not-a-uuid', '10000000-0000-4000-8000-00000000000', '1;DROP']) {
      expect(parseTaskSearch({ assignee: bad })).toEqual({});
    }
    expect(parseTaskSearch({ assignee: 'me' })).toEqual({ assignee: 'me' });
    expect(parseTaskSearch({ assignee: 'unassigned' })).toEqual({ assignee: 'unassigned' });
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

  it.each([
    ['non-object', 'boom'],
    ['bad status', { status: 'pwned' }],
    ['non-uuid taskId', { taskId: 'tsk_1' }],
    ['non-uuid org', { organizationId: '../x' }],
    ['title too long', { title: 'x'.repeat(501) }],
    ['bad timestamp', { at: 'yesterday' }],
    ['extra key', { html: '<b>' }],
    ['non-string assignee', { assigneeId: 7 }],
  ])('drops invalid realtime task events (%s)', async (_name, patch) => {
    const { queryClient } = renderApp('/tasks');
    await screen.findByText('Send recap');
    const valid = {
      organizationId: '00000000-0000-4000-8000-000000000001',
      taskId: '30000000-0000-4000-8000-000000000001',
      status: 'done',
      title: 'Hijacked',
      at: '2026-10-21T10:00:00.000Z',
    };
    const event = typeof patch === 'string' ? patch : { ...valid, ...patch };
    let applied = true;
    act(() => {
      applied = applyTaskUpdate(queryClient, event);
    });
    expect(applied).toBe(false);
    expect(screen.queryByText('Hijacked')).not.toBeInTheDocument();
    expect(screen.getByText('Send recap')).toBeInTheDocument();
  });

  it.each([
    '1',
    '2026',
    '2026-10-22',
    'Oct 22 2026',
    '2026-02-30T00:00:00Z',
    '2025-02-29T00:00:00Z',
    '2026-04-31T00:00:00Z',
    '2026-13-01T00:00:00Z',
    '2026-00-10T00:00:00Z',
    '2026-10-22T10:00:00',
    '2026-10-22T10:00:00.000',
    '2026-10-22T24:00:00Z',
    '2026-10-22T10:60:00Z',
    '2026-10-22 10:00:00Z',
    '2026-10-22T10:00:00+0530',
    '2026-10-22T10:00:00+24:00',
    ' 2026-10-22T10:00:00Z',
  ])('rejects non-strict ISO datetime %j for realtime `at`', async (at) => {
    expect(isIsoDateTime(at)).toBe(false);
    const { queryClient } = renderApp('/tasks');
    await screen.findByText('Send recap');
    let applied = true;
    act(() => {
      applied = applyTaskUpdate(queryClient, {
        organizationId: '00000000-0000-4000-8000-000000000001',
        taskId: '30000000-0000-4000-8000-000000000001',
        status: 'done',
        title: 'Hijacked',
        at,
      });
    });
    expect(applied).toBe(false);
    expect(screen.queryByText('Hijacked')).not.toBeInTheDocument();
  });

  it.each([
    '2026-10-22T10:00:00Z',
    '2026-10-22T10:00:00.123Z',
    '2026-10-22T15:30:00+05:30',
    '2026-10-22T05:00:00.5-04:00',
    '2024-02-29T23:59:59Z',
  ])('accepts strict ISO datetime %j', (at) => {
    expect(isIsoDateTime(at)).toBe(true);
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
    act(() => {
      expect(applyTaskUpdate(queryClient, event)).toBe(true);
    });
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
