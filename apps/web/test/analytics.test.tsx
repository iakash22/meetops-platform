import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeetingAnalytics } from '@meetops/contracts';
import { ApiError } from '@/lib/api/client';
import { createAnalyticsApi, formatDuration, rangeFor } from '@/features/analytics/api';
import { AnalyticsDashboard } from '@/features/analytics/analytics-page';
import { createMockApi, renderApp, resetStores } from './fixtures/render';

const ORG = '00000000-0000-4000-8000-000000000001';
const PREFIX = `/orgs/${ORG}/analytics/meetings?`;

const data = (over: Partial<MeetingAnalytics> = {}): MeetingAnalytics => ({
  organizationId: ORG,
  from: '2026-10-01T00:00:00.000Z',
  to: '2026-11-01T00:00:00.000Z',
  bucket: 'day',
  total: 5,
  bySource: [
    { source: 'upload', count: 3 },
    { source: 'extension', count: 2 },
    { source: 'bot', count: 0 },
  ],
  byStatus: [
    { status: 'completed', count: 4 },
    { status: 'failed', count: 1 },
  ],
  duration: { measured: 4, totalSec: 7_500, averageSec: 1_875 },
  periods: [
    { start: '2026-10-02T00:00:00.000Z', count: 2 },
    { start: '2026-10-05T00:00:00.000Z', count: 3 },
  ],
  ...over,
});

function apiWith(handler: (path: string) => unknown) {
  const request = vi.fn((_method: string, path: string) => {
    try {
      return Promise.resolve(handler(path));
    } catch (e) {
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
  return createMockApi({ request });
}

describe('analytics api helpers', () => {
  it('GETs the org-scoped contract path with the window and bucket', async () => {
    const request = vi.fn().mockResolvedValue(data());
    await createAnalyticsApi(request).meetings(ORG, {
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-11-01T00:00:00.000Z',
      bucket: 'week',
    });
    expect(request).toHaveBeenCalledWith(
      'GET',
      `/orgs/${ORG}/analytics/meetings?from=2026-10-01T00%3A00%3A00.000Z&to=2026-11-01T00%3A00%3A00.000Z&bucket=week`,
    );
  });
  it('builds a half-open UTC window ending at tomorrow', () => {
    const r = rangeFor('7d', new Date('2026-10-31T13:00:00.000Z'));
    expect(r).toEqual({
      from: '2026-10-25T00:00:00.000Z',
      to: '2026-11-01T00:00:00.000Z',
      bucket: 'day',
    });
    expect(rangeFor('365d').bucket).toBe('month');
  });
  it('formats durations', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(42)).toBe('42s');
    expect(formatDuration(1_875)).toBe('31m 15s');
    expect(formatDuration(7_500)).toBe('2h 5m');
  });
});

describe('AnalyticsDashboard', () => {
  it('renders totals, durations, breakdowns and periods, skipping zero rows', () => {
    render(<AnalyticsDashboard data={data()} />);
    expect(screen.getByTestId('stat-Meetings')).toHaveTextContent('5');
    expect(screen.getByTestId('stat-Total duration')).toHaveTextContent('2h 5m');
    expect(screen.getByTestId('stat-Average duration')).toHaveTextContent('31m 15s');
    const source = screen.getByRole('list', { name: 'By source' });
    expect(source).toHaveTextContent('Upload3');
    expect(source).toHaveTextContent('Browser extension2');
    expect(source).not.toHaveTextContent('Meeting bot');
    expect(screen.getByRole('list', { name: 'By status' })).toHaveTextContent('Failed1');
    expect(screen.getByRole('list', { name: 'Meetings per day' })).toHaveTextContent('Oct 5');
    expect(screen.getByText(/4 of 5 meetings/)).toBeInTheDocument();
  });
  it('shows a dash when no meeting has a duration', () => {
    render(
      <AnalyticsDashboard
        data={data({ duration: { measured: 0, totalSec: 0, averageSec: null } })}
      />,
    );
    expect(screen.getByTestId('stat-Average duration')).toHaveTextContent('—');
  });
});

describe('/analytics page', () => {
  beforeEach(() => resetStores());

  it('shows loading, then the dashboard, and refetches on range change', async () => {
    let resolve: (v: MeetingAnalytics) => void = () => {};
    const api = apiWith((p) =>
      p.startsWith(PREFIX)
        ? new Promise<MeetingAnalytics>((r) => {
            resolve = r;
          })
        : undefined,
    );
    renderApp('/analytics', api);
    expect(await screen.findByText('Loading analytics…')).toBeInTheDocument();
    resolve(data());
    expect(await screen.findByTestId('analytics-dashboard')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Last 90 days' }));
    await waitFor(() =>
      expect(api.request).toHaveBeenCalledWith(
        'GET',
        expect.stringMatching(/analytics\/meetings\?.*bucket=week$/),
      ),
    );
  });

  it('shows the empty state when the range has no meetings', async () => {
    const api = apiWith((p) =>
      p.startsWith(PREFIX)
        ? data({
            total: 0,
            bySource: [],
            byStatus: [],
            periods: [],
            duration: { measured: 0, totalSec: 0, averageSec: null },
          })
        : undefined,
    );
    renderApp('/analytics', api);
    expect(await screen.findByText('No meetings in this range')).toBeInTheDocument();
  });

  it('shows an error state with retry on a server error', async () => {
    const api = apiWith((p) => {
      if (p.startsWith(PREFIX)) throw new ApiError(500, 'INTERNAL', 'boom', 'req-1');
      return undefined;
    });
    renderApp('/analytics', api);
    expect(
      await screen.findByText("Couldn't load analytics", {}, { timeout: 4000 }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('treats 404 as not available, without retrying', async () => {
    const api = apiWith((p) => {
      if (p.startsWith(PREFIX)) throw new ApiError(404, 'NOT_FOUND', 'nope', 'req-2');
      return undefined;
    });
    renderApp('/analytics', api);
    expect(await screen.findByText("Analytics aren't available yet")).toBeInTheDocument();
    const calls = vi.mocked(api.request).mock.calls.filter(([, p]) => p.startsWith(PREFIX));
    expect(calls).toHaveLength(1);
  });
});
