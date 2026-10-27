import '@testing-library/react-native/extend-expect';
import type { Report } from '@meetops/contracts';
import { fireEvent, render, screen } from '@testing-library/react-native';

import { ApiError } from '../src/api/client';
import { InsightsScreen, formatOffset } from '../src/screens/InsightsScreen';

const ORG = '00000000-0000-4000-8000-000000000001';
const M = '00000000-0000-4000-8000-0000000000aa';

const seg = { id: 's1', index: 0, startMs: 65000, endMs: 70000, speaker: 'Asha', text: 'Ship it' };

describe('InsightsScreen', () => {
  it('renders transcript segments', async () => {
    const api = { transcript: jest.fn().mockResolvedValue({ segments: [seg] }), report: jest.fn() };
    render(<InsightsScreen api={api} organizationId={ORG} meetingId={M} />);
    expect(await screen.findByText('1:05')).toBeOnTheScreen();
    expect(api.transcript).toHaveBeenCalledWith(ORG, M);
    expect(api.report).not.toHaveBeenCalled();
  });

  it('shows "not ready yet" on a 404, without a toast', async () => {
    const api = {
      transcript: jest.fn().mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'x')),
      report: jest.fn(),
    };
    render(<InsightsScreen api={api} organizationId={ORG} meetingId={M} />);
    expect(await screen.findByTestId('transcript-not-ready')).toBeOnTheScreen();
    expect(screen.queryByTestId('transcript-toast')).toBeNull();
  });

  it('shows other errors with a toast and retries', async () => {
    const transcript = jest
      .fn()
      .mockRejectedValueOnce(new ApiError(500, 'INTERNAL', 'Boom'))
      .mockResolvedValue({ segments: [] });
    render(
      <InsightsScreen api={{ transcript, report: jest.fn() }} organizationId={ORG} meetingId={M} />,
    );
    expect(await screen.findByTestId('transcript-toast')).toHaveTextContent(/Boom/);
    fireEvent.press(screen.getByTestId('transcript-error-retry'));
    expect(await screen.findByTestId('transcript-empty')).toBeOnTheScreen();
  });

  it('loads the report tab on demand', async () => {
    const r = {
      summary: 'Agreed scope',
      decisions: ['Go'],
      risks: [],
      actionItems: [{ title: 'Write doc' }],
    } as unknown as Report;
    const api = {
      transcript: jest.fn().mockResolvedValue({ segments: [] }),
      report: jest.fn().mockResolvedValue(r),
    };
    render(<InsightsScreen api={api} organizationId={ORG} meetingId={M} />);
    await screen.findByTestId('transcript-empty');
    fireEvent.press(screen.getByTestId('tab-report'));
    expect(await screen.findByText('Agreed scope')).toBeOnTheScreen();
  });

  it('formats long offsets', () => expect(formatOffset(3_725_000)).toBe('1:02:05'));
});
