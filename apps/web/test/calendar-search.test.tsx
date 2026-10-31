import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CalendarProviderList, SearchResponse } from '@meetops/contracts';
import {
  createHttpCalendarApi,
  groupByDay,
  setCalendarApiOverride,
  weekWindow,
  type CalendarApi,
} from '@/features/calendar/api';
import { calendarRedirect } from '@/features/calendar/calendar-page';
import {
  createHttpSearchApi,
  parseSearchPageSearch,
  setSearchApiOverride,
  snippetParts,
  type SearchApi,
} from '@/features/search/api';
import { renderApp, resetStores } from './fixtures/render';

const ORG = '00000000-0000-4000-8000-000000000001';
const CONN = '70000000-0000-4000-8000-000000000001';
const MEETING = '80000000-0000-4000-8000-000000000001';
const T = '2026-10-01T00:00:00.000Z';

const providers = (
  over: Partial<CalendarProviderList['items'][number]> = {},
): CalendarProviderList => ({
  items: [{ provider: 'google', configured: true, ...over }],
});
const connected = providers({
  connection: {
    id: CONN,
    organizationId: ORG,
    userId: '10000000-0000-4000-8000-000000000001',
    provider: 'google',
    status: 'active',
    displayName: 'me@example.test',
    externalAccountId: 'me@example.test',
    createdAt: T,
    updatedAt: T,
  },
});

function calendarMock(p: CalendarProviderList): CalendarApi {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 10).toISOString();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 11).toISOString();
  return {
    providers: vi.fn().mockResolvedValue(p),
    connect: vi
      .fn()
      .mockResolvedValue({ authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth?state=s' }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    events: vi.fn().mockResolvedValue({
      items: [
        {
          id: 'e1',
          connectionId: CONN,
          provider: 'google',
          title: 'Weekly sync',
          startsAt: start,
          endsAt: end,
          allDay: false,
          status: 'confirmed',
          conferenceUrl: 'https://meet.google.com/abc-defg-hij',
          attendeeCount: 3,
        },
      ],
    }),
  };
}

describe('calendar + search helpers', () => {
  it('calendar http client uses the contract routes and never sends an endpoint', async () => {
    const request = vi.fn().mockResolvedValue({ items: [] });
    const api = createHttpCalendarApi(request);
    await api.providers(ORG);
    await api.connect(ORG, 'google');
    await api.events(ORG, '2026-11-01T00:00:00.000Z', '2026-11-08T00:00:00.000Z');
    expect(request.mock.calls[0]).toEqual(['GET', `/orgs/${ORG}/calendar/providers`]);
    expect(request.mock.calls[1]).toEqual([
      'POST',
      `/orgs/${ORG}/calendar/connect`,
      { provider: 'google', returnTo: '/calendar' },
    ]);
    expect(request.mock.calls[2]![1]).toBe(
      `/orgs/${ORG}/calendar/events?from=2026-11-01T00%3A00%3A00.000Z&to=2026-11-08T00%3A00%3A00.000Z`,
    );
  });
  it('week window starts on Monday and spans 7 days', () => {
    const { from, to } = weekWindow(new Date(2026, 9, 31)); // Saturday
    expect(from.getDay()).toBe(1);
    expect(from.getDate()).toBe(26);
    expect((to.getTime() - from.getTime()) / 86_400_000).toBeCloseTo(7, 0);
    expect(groupByDay([{ startsAt: new Date(2026, 9, 26, 9).toISOString() }])[0]![0]).toBe(
      '2026-10-26',
    );
  });
  it('search client, snippet parts and search params', async () => {
    const request = vi.fn().mockResolvedValue({ items: [] });
    await createHttpSearchApi(request).search(ORG, 'a b', ['task']);
    expect(request.mock.calls[0]).toEqual(['GET', `/orgs/${ORG}/search?q=a+b&kinds=task`]);
    expect(snippetParts('ship \u0002billing\u0003 now')).toEqual([
      { text: 'ship ', match: false },
      { text: 'billing', match: true },
      { text: ' now', match: false },
    ]);
    expect(parseSearchPageSearch({ q: 'x', kind: 'users' })).toEqual({ q: 'x', kind: undefined });
  });
});

describe('CalendarPage', () => {
  beforeEach(() => resetStores());
  afterEach(() => {
    setCalendarApiOverride(null);
    vi.restoreAllMocks();
  });

  it('shows connect when not connected and redirects to the https authorize url', async () => {
    const nav = vi.spyOn(calendarRedirect, 'assign').mockImplementation(() => undefined);
    const mock = calendarMock(providers());
    const eventsSpy = vi.fn();
    mock.events = eventsSpy;
    setCalendarApiOverride(mock);
    renderApp('/calendar');
    const card = await screen.findByTestId('calendar-google');
    expect(within(card).getByText('Not connected')).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: 'Connect Google Calendar' }));
    await waitFor(() =>
      expect(nav).toHaveBeenCalledWith('https://accounts.google.com/o/oauth2/v2/auth?state=s'),
    );
    expect(eventsSpy).not.toHaveBeenCalled();
  });

  it('explains when the provider is not configured', async () => {
    setCalendarApiOverride(calendarMock(providers({ configured: false })));
    renderApp('/calendar');
    expect(await screen.findByText(/not set up on this deployment/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Connect Google Calendar' }),
    ).not.toBeInTheDocument();
  });

  it('lists this week events with a join link when connected', async () => {
    setCalendarApiOverride(calendarMock(connected));
    renderApp('/calendar');
    expect(await screen.findByText('Weekly sync')).toBeInTheDocument();
    const join = screen.getByRole('link', { name: 'Join' });
    expect(join).toHaveAttribute('href', 'https://meet.google.com/abc-defg-hij');
    expect(join).toHaveAttribute('rel', 'noopener noreferrer');
  });
});

describe('SearchPage', () => {
  beforeEach(() => resetStores());
  afterEach(() => setSearchApiOverride(null));

  it('renders highlighted results as text and links to the meeting', async () => {
    const res: SearchResponse = {
      items: [
        {
          kind: 'transcript',
          id: '90000000-0000-4000-8000-000000000001',
          meetingId: MEETING,
          title: 'Billing sync',
          snippet: 'we will ship \u0002billing\u0003 <img src=x onerror=alert(1)>',
          rank: 0.5,
          occurredAt: T,
        },
      ],
    };
    const search = vi.fn().mockResolvedValue(res);
    const api: SearchApi = { search };
    setSearchApiOverride(api);
    renderApp('/search?q=billing');
    const list = await screen.findByRole('list', { name: 'Search results' });
    expect(within(list).getByText('billing').tagName).toBe('MARK');
    expect(list.querySelector('img')).toBeNull();
    expect(within(list).getByRole('link')).toHaveAttribute('href', `/meetings/${MEETING}`);
    expect(search).toHaveBeenCalledWith(ORG, 'billing', undefined);
  });

  it('does not search for fewer than two characters', async () => {
    const search = vi.fn();
    const api: SearchApi = { search };
    setSearchApiOverride(api);
    renderApp('/search');
    expect(await screen.findByText('Start typing')).toBeInTheDocument();
    expect(search).not.toHaveBeenCalled();
  });
});
