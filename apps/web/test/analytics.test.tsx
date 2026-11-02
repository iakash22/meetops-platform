import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MeetingAnalytics } from '@meetops/contracts';
import { MAX_ANALYTICS_RANGE_DAYS } from '@meetops/contracts/types';
import { ApiError } from '@/lib/api/client';
import {
  RANGE_PRESETS,
  createAnalyticsApi,
  formatDuration,
  rangeFor,
  windowFor,
} from '@/features/analytics/api';
import { AnalyticsDashboard } from '@/features/analytics/analytics-page';
import { createMockApi, renderApp, resetStores } from './fixtures/render';

const ORG = '00000000-0000-4000-8000-000000000001';
const PREFIX = `/orgs/${ORG}/analytics/meetings?`;
const DAY_MS = 86_400_000;
const spanDays = (q: { from: string; to: string }) =>
  (Date.parse(q.to) - Date.parse(q.from)) / DAY_MS;

/** 13 UTC month buckets, Nov 2025 .. Nov 2026, as the API returns for the 12-month preset. */
const monthPeriods = Array.from({ length: 13 }, (_, i) => ({
  start: new Date(Date.UTC(2025, 10 + i, 1)).toISOString(),
  count: i + 1,
}));
const twelveMonths = (over: Partial<MeetingAnalytics> = {}): MeetingAnalytics =>
  data({
    from: '2025-11-01T00:00:00.000Z',
    to: '2026-11-01T00:00:00.000Z',
    bucket: 'month',
    total: 91,
    periods: monthPeriods,
    ...over,
  });

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

describe('range cap (MAX_ANALYTICS_RANGE_DAYS)', () => {
  const now = new Date('2026-10-31T13:00:00.000Z');

  it('is 366 days, the same cap the API enforces (366 → 200, 367 → 400 in apps/api/test/analytics.test.ts)', () => {
    expect(MAX_ANALYTICS_RANGE_DAYS).toBe(366);
  });
  it('the 12-month preset is a 365-day, month-bucketed window inside the cap', () => {
    const r = rangeFor('365d', now);
    expect(r).toEqual({
      from: '2025-11-01T00:00:00.000Z',
      to: '2026-11-01T00:00:00.000Z',
      bucket: 'month',
    });
    expect(spanDays(r)).toBe(365);
  });
  it('allows exactly 366 days unchanged', () => {
    const r = windowFor(366, 'month', now);
    expect(spanDays(r)).toBe(366);
    expect(r).toEqual({
      from: '2025-10-31T00:00:00.000Z',
      to: '2026-11-01T00:00:00.000Z',
      bucket: 'month',
    });
  });
  it('clamps 367 days (or more) to 366, so the client never sends a range the API rejects', () => {
    expect(windowFor(367, 'month', now)).toEqual(windowFor(366, 'month', now));
    expect(spanDays(windowFor(367, 'day', now))).toBe(366);
    expect(spanDays(windowFor(10_000, 'week', now))).toBe(366);
  });
  it('no preset exceeds the cap', () => {
    for (const p of RANGE_PRESETS) {
      expect(spanDays(rangeFor(p.id, now))).toBe(Math.min(p.days, MAX_ANALYTICS_RANGE_DAYS));
      expect(spanDays(rangeFor(p.id, now))).toBeLessThanOrEqual(MAX_ANALYTICS_RANGE_DAYS);
    }
  });
});

describe('AnalyticsDashboard', () => {
  it('renders a 12-month view: one UTC month bar per bucket, labelled by month and year', () => {
    render(<AnalyticsDashboard data={twelveMonths()} />);
    const list = screen.getByRole('list', { name: 'Meetings per month' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(13);
    expect(rows[0]).toHaveTextContent('Nov 2025');
    expect(rows[0]).toHaveTextContent('1');
    expect(rows[12]).toHaveTextContent('Nov 2026');
    expect(rows[12]).toHaveTextContent('13');
    expect(screen.getByTestId('stat-Meetings')).toHaveTextContent('91');
  });

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

  it('the Last 12 months preset requests a 365-day month window and renders the month view', async () => {
    const api = apiWith((p) => {
      if (!p.startsWith(PREFIX)) return undefined;
      return new URLSearchParams(p.slice(PREFIX.length)).get('bucket') === 'month'
        ? twelveMonths()
        : data();
    });
    renderApp('/analytics', api);
    expect(await screen.findByTestId('analytics-dashboard')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Last 12 months' }));
    expect(screen.getByRole('button', { name: 'Last 12 months' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const list = await screen.findByRole('list', { name: 'Meetings per month' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(13);
    const monthCall = vi
      .mocked(api.request)
      .mock.calls.map(([, p]) => p)
      .find((p) => p.startsWith(PREFIX) && p.endsWith('bucket=month'));
    expect(monthCall).toBeDefined();
    const params = new URLSearchParams(monthCall!.slice(PREFIX.length));
    expect(spanDays({ from: params.get('from')!, to: params.get('to')! })).toBe(365);
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
