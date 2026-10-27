import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Task } from '@meetops/contracts';

import { DataProvider, createDataSource } from '@/features/data/repositories';
import { createNativeTaskReviewApi } from '@/features/tasks/review-api';
import {
  buildUpdate,
  fieldErrorsFromPaths,
  TASK_PATHS,
  validateEdit,
} from '@/features/tasks/task-review-core';
import { TaskReviewPanel } from '@/features/tasks/task-review-panel';
import type { Invoke } from '@/lib/native-auth';

const ORG = '00000000-0000-4000-8000-000000000001';
vi.mock('@/features/auth/session', () => ({
  useSession: () => ({ session: { activeOrganizationId: ORG } }),
}));

// eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- mirrors Tauri IPC rejections
const ipcReject = (value: unknown) => Promise.reject(value);
const T = '2026-01-05T11:00:00.000Z';
const ex = {
  id: '40000000-0000-4000-8000-000000000001',
  meetingId: '10000000-0000-4000-8000-000000000001',
  reportId: '30000000-0000-4000-8000-000000000001',
  title: 'Ship notes',
  confidence: 0.9,
  sourceSegmentIds: [],
  createdAt: T,
};
const task: Task = {
  id: '50000000-0000-4000-8000-000000000001',
  organizationId: ORG,
  title: 'Ship notes',
  status: 'todo',
  priority: 'medium',
  createdAt: T,
  updatedAt: T,
};

function renderWith(invoke: Invoke) {
  return render(
    <DataProvider value={createDataSource(invoke)}>
      <TaskReviewPanel />
    </DataProvider>,
  );
}

describe('task review core', () => {
  it('builds the contracts paths through api_request', async () => {
    const invoke = vi.fn(async () => ({ items: [] })) as unknown as Invoke;
    const api = createNativeTaskReviewApi(invoke);
    await api.pending(ORG);
    await api.accept(ORG, 'a/b', { title: 't', priority: 'low' });
    await api.dismiss(ORG, 'x');
    await api.update(ORG, 't 1', { title: 'n' });
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ['api_request', { method: 'GET', path: `/orgs/${ORG}/extracted-tasks?limit=50` }],
      [
        'api_request',
        {
          method: 'POST',
          path: `/orgs/${ORG}/extracted-tasks/a%2Fb/accept`,
          body: { title: 't', priority: 'low' },
        },
      ],
      ['api_request', { method: 'POST', path: `/orgs/${ORG}/extracted-tasks/x/dismiss` }],
      ['api_request', { method: 'PATCH', path: `/orgs/${ORG}/tasks/t%201`, body: { title: 'n' } }],
    ]);
    expect(TASK_PATHS.task).toBe('/orgs/:organizationId/tasks/:taskId');
  });

  it('edit helpers send only changed keys and null to clear', () => {
    const t = { ...task, description: 'd', dueAt: '2026-11-01T00:00:00.000Z' };
    const base = {
      title: 'Ship notes',
      description: 'd',
      priority: 'medium',
      status: 'todo',
      due: '2026-11-01',
    } as const;
    expect(buildUpdate(t, base)).toEqual({});
    expect(buildUpdate(t, { ...base, description: '', due: '', status: 'done' })).toEqual({
      description: null,
      dueAt: null,
      status: 'done',
    });
    expect(validateEdit({ ...base, title: ' ', due: '11/01' })).toEqual({
      title: 'Enter a title.',
      dueAt: 'Enter a date as YYYY-MM-DD.',
    });
    expect(fieldErrorsFromPaths(['/title'])).toEqual({ title: 'Enter a valid title.' });
  });
});

describe('TaskReviewPanel', () => {
  it('accepts, then edits with inline errors, then saves a minimal patch', async () => {
    const calls: unknown[] = [];
    let patches = 0;
    const invoke = vi.fn(async (_c: string, a?: Record<string, unknown>) => {
      calls.push(a);
      const path = String(a?.path);
      if (a?.method === 'GET') return { items: [ex], nextCursor: null };
      if (path.endsWith('/accept')) return task;
      if (a?.method === 'PATCH') {
        if (patches++ === 0)
          return ipcReject({ code: 'VALIDATION_FAILED', message: 'Title is invalid.' });
        return { ...task, ...(a.body as object) };
      }
      return null;
    }) as unknown as Invoke;
    renderWith(invoke);
    const form = await screen.findByRole('form', { name: 'Review Ship notes' });
    await userEvent.click(within(form).getByRole('button', { name: 'Accept' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Edit Ship notes' }));
    const edit = screen.getByRole('form', { name: 'Edit task' });
    const title = within(edit).getByLabelText('Title');
    await userEvent.clear(title);
    await userEvent.click(within(edit).getByRole('button', { name: 'Save changes' }));
    expect(within(edit).getByText('Enter a title.')).toBeInTheDocument();
    expect(title).toHaveAttribute('aria-invalid', 'true');
    await userEvent.type(title, 'Ship it');
    await userEvent.click(within(edit).getByRole('button', { name: 'Save changes' }));
    expect(await within(edit).findByRole('alert')).toHaveTextContent('Title is invalid.');
    await userEvent.selectOptions(within(edit).getByLabelText('Priority'), 'urgent');
    await userEvent.click(within(edit).getByRole('button', { name: 'Save changes' }));
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Edit task' })).not.toBeInTheDocument(),
    );
    expect(calls.at(-1)).toEqual({
      method: 'PATCH',
      path: `/orgs/${ORG}/tasks/${task.id}`,
      body: { title: 'Ship it', priority: 'urgent' },
    });
    expect(screen.getByText('Ship it')).toBeInTheDocument();
  });

  it('a 409 on dismiss removes the row and toasts; validates the accept title inline', async () => {
    const invoke = vi.fn(async (_c: string, a?: Record<string, unknown>) =>
      a?.method === 'GET'
        ? { items: [ex], nextCursor: null }
        : ipcReject({ code: 'CONFLICT', message: 'Already reviewed.' }),
    ) as unknown as Invoke;
    renderWith(invoke);
    const form = await screen.findByRole('form', { name: 'Review Ship notes' });
    await userEvent.clear(within(form).getByLabelText('Title'));
    await userEvent.click(within(form).getByRole('button', { name: 'Accept' }));
    expect(within(form).getByText('Enter a title.')).toBeInTheDocument();
    await userEvent.click(within(form).getByRole('button', { name: 'Dismiss' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/already reviewed/i);
    expect(screen.getByText('Nothing to review.')).toBeInTheDocument();
  });

  it('shows a retry and toast when the list fails; 404 counts as empty', async () => {
    const failing = vi.fn(async () =>
      ipcReject({ code: 'INTERNAL', message: 'Boom.' }),
    ) as unknown as Invoke;
    const { unmount } = renderWith(failing);
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Boom.');
    unmount();
    renderWith(vi.fn(async () => ipcReject({ code: 'NOT_FOUND', message: 'x' })));
    expect(await screen.findByText('Nothing to review.')).toBeInTheDocument();
  });
});
