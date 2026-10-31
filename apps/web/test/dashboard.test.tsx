import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/client';
import { createMockApi, renderApp, resetStores } from './fixtures/render';

describe('dashboard overview', () => {
  beforeEach(() => resetStores());

  it('lists recent meetings and open tasks from the API', async () => {
    const api = createMockApi();
    renderApp('/', api);
    expect(await screen.findByRole('link', { name: 'Weekly sync' })).toBeInTheDocument();
    expect(await screen.findByText('Send recap')).toBeInTheDocument();
    expect(api.tasks.list).toHaveBeenCalledWith(expect.any(String), { status: 'todo' });
  });

  it('shows an error state with retry when meetings fail', async () => {
    const api = createMockApi({
      meetings: { list: vi.fn().mockRejectedValue(new ApiError(500, 'INTERNAL', 'x', 'req_9')) },
    });
    renderApp('/', api);
    expect(await screen.findByTestId('error-state')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });
});
