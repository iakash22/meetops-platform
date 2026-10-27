import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/client';
import { fromMatrix, toMatrix } from '@/features/notifications/preferences-panel';
import { createMockApi, renderApp, resetStores } from './fixtures/render';

const ORG = '00000000-0000-4000-8000-000000000001';
const PATH = `/orgs/${ORG}/notification-preferences`;

function apiWith(handler: (method: string, path: string, body?: unknown) => unknown) {
  const request = vi.fn((method: string, path: string, body?: unknown) => {
    try {
      return Promise.resolve(handler(method, path, body));
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
  return createMockApi({ request });
}

describe('notification preferences matrix', () => {
  it('falls back to the * row, then enabled, and round-trips every cell', () => {
    const m = toMatrix([{ type: '*', channel: 'email', enabled: false }]);
    expect(m['task.assigned']!.email).toBe(false);
    expect(m['task.assigned']!.in_app).toBe(true);
    expect(fromMatrix(m)).toHaveLength(30);
  });
});

describe('/settings?tab=notifications', () => {
  beforeEach(() => resetStores());

  it('loads preferences and PUTs the full set on save', async () => {
    const api = apiWith((m, p, body) =>
      p === PATH ? (m === 'PUT' ? body : { items: [] }) : undefined,
    );
    renderApp('/settings?tab=notifications', api);
    const box = await screen.findByRole('checkbox', { name: 'Task assigned via Email' });
    expect(box).toBeChecked();
    await userEvent.click(box);
    await userEvent.click(screen.getByRole('button', { name: 'Save preferences' }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        'PUT',
        PATH,
        expect.objectContaining({
          items: expect.arrayContaining([
            { type: 'task.assigned', channel: 'email', enabled: false },
          ]) as unknown,
        }),
      ),
    );
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('shows "not available" on 404', async () => {
    const api = apiWith((_m, p) => {
      if (p === PATH) throw new ApiError(404, 'NOT_FOUND', 'no', 'r');
      return undefined;
    });
    renderApp('/settings?tab=notifications', api);
    expect(
      await screen.findByText("Notification preferences aren't available yet"),
    ).toBeInTheDocument();
  });
});
