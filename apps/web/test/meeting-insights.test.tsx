import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Report, Transcript } from '@meetops/contracts';
import { ApiError } from '@/lib/api/client';
import { createHttpMeetingInsightsApi, formatOffset } from '@/features/meetings/insights-api';
import { meeting1 } from './fixtures/data';
import { createMockApi, renderApp, resetStores } from './fixtures/render';
import { waitForRouteData } from './fixtures/route-ready';

const ORG = '00000000-0000-4000-8000-000000000001';
const T = '2026-10-20T11:00:00.000Z';
const transcript: Transcript = {
  id: '30000000-0000-4000-8000-000000000001',
  meetingId: meeting1.id,
  recordingId: '30000000-0000-4000-8000-000000000009',
  provider: 'assemblyai',
  segments: [
    {
      id: '31000000-0000-4000-8000-000000000002',
      index: 1,
      startMs: 65_000,
      endMs: 70_000,
      speaker: 'Bo',
      text: 'Ship Friday.',
    },
    {
      id: '31000000-0000-4000-8000-000000000001',
      index: 0,
      startMs: 0,
      endMs: 5_000,
      speaker: 'Ana',
      text: 'Welcome everyone.',
    },
  ],
  createdAt: T,
};
const report: Report = {
  id: '32000000-0000-4000-8000-000000000001',
  organizationId: ORG,
  meetingId: meeting1.id,
  summary: '<b>We agreed</b> on the release.',
  decisions: ['Release Friday'],
  risks: ['QA capacity'],
  actionItems: [{ title: 'Write notes', assigneeHint: 'Ana', dueHint: 'Thu' }],
  aiRunId: null,
  createdAt: T,
};

describe('meeting insights', () => {
  beforeEach(() => resetStores());

  it('formats offsets', () => {
    expect(formatOffset(0)).toBe('0:00');
    expect(formatOffset(65_000)).toBe('1:05');
    expect(formatOffset(3_725_000)).toBe('1:02:05');
  });

  it('builds encoded org-scoped paths', async () => {
    const request = vi.fn().mockResolvedValue({});
    const api = createHttpMeetingInsightsApi(request);
    await api.transcript(ORG, 'a/b');
    await api.report(ORG, 'm1');
    expect(request).toHaveBeenNthCalledWith(1, 'GET', `/orgs/${ORG}/meetings/a%2Fb/transcript`);
    expect(request).toHaveBeenNthCalledWith(2, 'GET', `/orgs/${ORG}/meetings/m1/report`);
  });

  it('renders the report as text and the transcript in order, with search', async () => {
    const { api } = renderApp(
      `/meetings/${meeting1.id}`,
      createMockApi({
        meetingInsights: {
          transcript: vi.fn().mockResolvedValue(transcript),
          report: vi.fn().mockResolvedValue(report),
        },
      }),
    );
    await waitForRouteData(api.meetings.get);
    expect(await screen.findByText('<b>We agreed</b> on the release.')).toBeInTheDocument();
    expect(screen.getByText('Release Friday')).toBeInTheDocument();
    expect(screen.getByText('QA capacity')).toBeInTheDocument();
    expect(screen.getByText('Ana · Thu')).toBeInTheDocument();
    const list = screen.getByRole('list', { name: 'Transcript' });
    expect(list.textContent?.indexOf('Welcome')).toBeLessThan(list.textContent.indexOf('Ship'));
    expect(screen.getByText('1:05')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Search transcript'), 'friday');
    await waitFor(() => expect(screen.queryByText('Welcome everyone.')).not.toBeInTheDocument());
    expect(screen.getByText('Ship Friday.')).toBeInTheDocument();
    await userEvent.clear(screen.getByLabelText('Search transcript'));
    await userEvent.type(screen.getByLabelText('Search transcript'), 'zzz');
    expect(await screen.findByText('No lines match.')).toBeInTheDocument();
  });

  it('does not fetch insights before the meeting is completed', async () => {
    const api = createMockApi({
      meetings: { get: vi.fn().mockResolvedValue({ ...meeting1, status: 'processing' }) },
    });
    renderApp(`/meetings/${meeting1.id}`, api);
    await waitForRouteData(api.meetings.get);
    expect(await screen.findByText('Transcript not available yet')).toBeInTheDocument();
    expect(api.meetingInsights.transcript).not.toHaveBeenCalled();
    expect(api.meetingInsights.report).not.toHaveBeenCalled();
  });

  it('shows an error state with retry on a server error', async () => {
    const api = createMockApi({
      meetingInsights: {
        report: vi.fn().mockRejectedValue(new ApiError(500, 'INTERNAL', 'x', 'req_9')),
      },
    });
    renderApp(`/meetings/${meeting1.id}`, api);
    await waitForRouteData(api.meetings.get);
    expect(await screen.findByTestId('error-state', {}, { timeout: 5000 })).toHaveTextContent(
      'req_9',
    );
    expect(screen.getByText('Transcript not available yet')).toBeInTheDocument();
  });
});
