import '@testing-library/react-native/extend-expect';
import type { Task } from '@meetops/contracts';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { ApiError } from '../src/api/client';
import { createHttpTaskReviewApi } from '../src/tasks/reviewApi';
import { TaskReviewPanel } from '../src/tasks/TaskReviewPanel';
import { buildUpdate, validateEdit, toEditValues } from '../src/tasks/taskReviewCore';

const ORG = '00000000-0000-4000-8000-000000000001';
const X = {
  id: 'x1',
  meetingId: 'm',
  reportId: 'r',
  title: 'Share notes',
  confidence: 0.9,
  sourceSegmentIds: [],
  createdAt: 'T',
};
const TASK: Task = {
  id: 't1',
  organizationId: ORG,
  title: 'Share notes',
  status: 'todo',
  priority: 'medium',
  createdAt: 'T',
  updatedAt: 'T',
};

const mkApi = (over = {}) => ({
  pending: jest.fn().mockResolvedValue({ items: [X], nextCursor: null }),
  accept: jest.fn().mockResolvedValue(TASK),
  dismiss: jest.fn().mockResolvedValue(undefined),
  update: jest.fn().mockResolvedValue({ ...TASK, title: 'New' }),
  ...over,
});

describe('TaskReviewPanel', () => {
  it('accepts, then edits with a minimal patch', async () => {
    const api = mkApi();
    render(<TaskReviewPanel api={api} organizationId={ORG} />);
    fireEvent.press(await screen.findByTestId('accept-x1'));
    fireEvent.press(await screen.findByTestId('edit-t1'));
    fireEvent.changeText(screen.getByTestId('edit-title'), 'New');
    fireEvent.press(screen.getByTestId('edit-save'));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith(ORG, 't1', { title: 'New' }));
    expect(await screen.findByText('New')).toBeOnTheScreen();
  });

  it('dismisses; a 409 shows the already-reviewed toast', async () => {
    const api = mkApi({ dismiss: jest.fn().mockRejectedValue(new ApiError(409, 'CONFLICT', 'x')) });
    render(<TaskReviewPanel api={api} organizationId={ORG} />);
    fireEvent.press(await screen.findByTestId('dismiss-x1'));
    expect(await screen.findByTestId('task-review-toast')).toHaveTextContent(/already reviewed/);
    expect(screen.getByTestId('task-review-empty')).toBeOnTheScreen();
  });

  it('treats a 404 list as empty without a toast', async () => {
    const api = mkApi({
      pending: jest.fn().mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'x')),
    });
    render(<TaskReviewPanel api={api} organizationId={ORG} />);
    expect(await screen.findByTestId('task-review-empty')).toBeOnTheScreen();
    expect(screen.queryByTestId('task-review-toast')).toBeNull();
  });

  it('shows field errors inline and does not send', async () => {
    const api = mkApi();
    render(<TaskReviewPanel api={api} organizationId={ORG} />);
    fireEvent.press(await screen.findByTestId('accept-x1'));
    fireEvent.press(await screen.findByTestId('edit-t1'));
    fireEvent.changeText(screen.getByTestId('edit-due'), 'soon');
    fireEvent.press(screen.getByTestId('edit-save'));
    expect(await screen.findByTestId('edit-due-error')).toBeOnTheScreen();
    expect(api.update).not.toHaveBeenCalled();
  });
});

describe('task review core + http', () => {
  it('builds a minimal patch and validates dates', () => {
    const v = { ...toEditValues(TASK), description: '', due: '' };
    expect(buildUpdate(TASK, v)).toEqual({});
    expect(validateEdit({ ...v, due: '2026-13' }).dueAt).toBeDefined();
  });

  it('uses TASK_PATHS with 201/204 expectations', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce({ status: 201, text: () => Promise.resolve(JSON.stringify(TASK)) })
      .mockResolvedValueOnce({ status: 204, text: () => Promise.resolve('') });
    const api = createHttpTaskReviewApi({
      baseUrl: 'https://api.test',
      fetchImpl: fetchImpl,
    });
    await expect(api.accept(ORG, 'x1', { title: 'a', priority: 'low' })).resolves.toEqual(TASK);
    await api.dismiss(ORG, 'x1');
    expect(fetchImpl.mock.calls[0][0]).toMatch(/\/extracted-tasks\/x1\/accept$/);
    expect(fetchImpl.mock.calls[1][1].method).toBe('POST');
  });
});
