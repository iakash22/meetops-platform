import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/client';
import { createNotificationsApi, type AppNotification } from '@/features/notifications/api';
import { createMockApi, renderApp, resetStores } from './fixtures/render';

const ORG = '00000000-0000-4000-8000-000000000001';
const n1: AppNotification = {
  id: '40000000-0000-4000-8000-000000000001',
  organizationId: ORG,
  kind: 'report.ready',
  title: 'Summary ready: Weekly sync',
  meetingId: '20000000-0000-4000-8000-000000000001',
  readAt: null,
  createdAt: '2026-10-27T10:00:00.000Z',
};

function apiWith(handler: (method: string, path: string) => unknown) {
  const request = vi.fn((method: string, path: string) => {
    try {
      return Promise.resolve(handler(method, path));
    } catch (e) {
      return Promise.reject(e);
    }
  });
  return createMockApi({ request: request as never });
}

describe('notifications client', () => {
  it('builds encoded org-scoped paths', async () => {
    const request = vi.fn().mockResolvedValue(undefined);
    const api = createNotificationsApi(request);
    await api.list('o/1', 'c 1');
    await api.markRead('o', 'n1');
    await api.markAllRead('o');
    expect(request.mock.calls).toEqual([
      ['GET', '/orgs/o%2F1/notifications?cursor=c%201'],
      ['POST', '/orgs/o/notifications/n1/read'],
      ['POST', '/orgs/o/notifications/read-all'],
    ]);
  });
});

describe('notifications page', () => {
  beforeEach(() => resetStores());

  it('is in the main nav and lists notifications with a meeting link', async () => {
    const api = apiWith(() => ({ items: [n1], nextCursor: null }));
    renderApp('/notifications', api);
    expect(await screen.findByText('Summary ready: Weekly sync')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open meeting' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Notifications' })).toBeInTheDocument();
  });

  it('marks one notification read', async () => {
    const api = apiWith((m) => (m === 'GET' ? { items: [n1], nextCursor: null } : undefined));
    renderApp('/notifications', api);
    await userEvent.click(await screen.findByRole('button', { name: /Mark "Summary/ }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith('POST', `/orgs/${ORG}/notifications/${n1.id}/read`),
    );
  });

  it('shows "not available yet" when the API has no route (404)', async () => {
    const api = apiWith(() => {
      throw new ApiError(404, 'NOT_FOUND', 'no', 'req_1');
    });
    renderApp('/notifications', api);
    expect(await screen.findByText("Notifications aren't available yet")).toBeInTheDocument();
  });

  it('shows an error state for other failures', async () => {
    const api = apiWith(() => {
      throw new ApiError(500, 'INTERNAL', 'x', 'req_2');
    });
    renderApp('/notifications', api);
    expect(await screen.findByTestId('error-state', {}, { timeout: 3000 })).toBeInTheDocument();
  });
});
