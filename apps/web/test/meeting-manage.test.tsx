import { nonNotificationCalls } from './fixtures/route-ready';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Meeting } from '@meetops/contracts';
import { ApiError } from '@/lib/api/client';
import {
  MEETING_MANAGE_PATHS,
  filterMeetings,
  fromLocalInput,
  toLocalInput,
} from '@/features/meetings/manage-api';
import { meeting1 } from './fixtures/data';
import { createMockApi, renderApp, resetStores } from './fixtures/render';
import { waitForRouteData } from './fixtures/route-ready';

const ORG = '00000000-0000-4000-8000-000000000001';
const m2: Meeting = {
  ...meeting1,
  id: '20000000-0000-4000-8000-000000000003',
  title: 'Design review',
  status: 'failed',
};

describe('meeting filters', () => {
  it('filters by title and status', () => {
    expect(filterMeetings([meeting1, m2], { q: 'design', status: '' })).toEqual([m2]);
    expect(filterMeetings([meeting1, m2], { q: '', status: 'failed' })).toEqual([m2]);
    expect(filterMeetings([meeting1, m2], { q: 'weekly', status: 'failed' })).toEqual([]);
  });
  it('round-trips datetime-local values', () => {
    const iso = fromLocalInput('2026-10-26T10:30');
    expect(iso).toBeDefined();
    expect(toLocalInput(iso)).toBe('2026-10-26T10:30');
    expect(fromLocalInput('')).toBeUndefined();
  });

  beforeEach(() => resetStores());

  it('search box narrows the list and shows a no-match state', async () => {
    const api = createMockApi({
      meetings: { list: vi.fn().mockResolvedValue({ items: [meeting1, m2], nextCursor: null }) },
    });
    renderApp('/meetings', api);
    await waitForRouteData(api.meetings.list, { heading: 'Meetings' });
    await screen.findByText('Design review');
    await userEvent.type(screen.getByRole('searchbox', { name: 'Search meetings' }), 'design');
    await waitFor(() => expect(screen.queryByText('Weekly sync')).not.toBeInTheDocument());
    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Filter by status' }),
      'completed',
    );
    expect(await screen.findByText('No matching meetings')).toBeInTheDocument();
  });
});

describe('meeting create/edit', () => {
  beforeEach(() => resetStores());

  it('validates inline, then POSTs and toasts', async () => {
    const { api } = renderApp('/meetings');
    await waitForRouteData(api.meetings.list, { heading: 'Meetings' });
    (api.request as Mock).mockResolvedValue({ ...meeting1, id: m2.id, title: 'Kickoff' });
    await userEvent.click(screen.getByRole('button', { name: 'New meeting' }));
    await userEvent.click(screen.getByRole('button', { name: 'Create meeting' }));
    expect(await screen.findByText('Enter a title.')).toBeInTheDocument();
    expect(nonNotificationCalls(api.request)).toEqual([]);
    await userEvent.type(screen.getByLabelText('Title'), '  Kickoff ');
    await userEvent.click(screen.getByRole('button', { name: 'Create meeting' }));
    expect(await screen.findByText('Meeting created')).toBeInTheDocument();
    expect(api.request).toHaveBeenCalledWith('POST', MEETING_MANAGE_PATHS.create(ORG), {
      title: 'Kickoff',
    });
  });

  it('maps a server 422 to the field and PATCHes on edit', async () => {
    const { api } = renderApp(`/meetings/${meeting1.id}`);
    await waitForRouteData(api.meetings.get);
    await screen.findByRole('heading', { name: 'Weekly sync' });
    (api.request as Mock).mockRejectedValueOnce(
      new ApiError(422, 'VALIDATION_FAILED', 'bad', undefined, [{ path: '/title', message: 'x' }]),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Title')).toHaveValue('Weekly sync');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Enter a valid title.')).toBeInTheDocument();
    (api.request as Mock).mockResolvedValueOnce({ ...meeting1, title: 'Weekly sync 2' });
    await userEvent.type(screen.getByLabelText('Title'), ' 2');
    await userEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Meeting updated')).toBeInTheDocument();
    expect(api.request).toHaveBeenLastCalledWith(
      'PATCH',
      MEETING_MANAGE_PATHS.update(ORG, meeting1.id),
      expect.objectContaining({ title: 'Weekly sync 2' }),
    );
  });

  it('non-field errors become a toast', async () => {
    const { api } = renderApp('/meetings');
    await waitForRouteData(api.meetings.list, { heading: 'Meetings' });
    (api.request as Mock).mockRejectedValueOnce(new ApiError(500, 'INTERNAL', 'boom'));
    await userEvent.click(screen.getByRole('button', { name: 'New meeting' }));
    await userEvent.type(screen.getByLabelText('Title'), 'X');
    await userEvent.click(screen.getByRole('button', { name: 'Create meeting' }));
    await waitFor(() => expect(document.querySelector('[data-sonner-toast]')).not.toBeNull());
  });
});
