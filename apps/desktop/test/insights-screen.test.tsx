import type { Meeting, Report, Transcript } from '@meetops/contracts';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { AuthError } from '@/features/auth/auth-client';
import { DataProvider, createDataSource, type DataSource } from '@/features/data/repositories';
import { InsightsScreen, formatOffset } from '@/features/meetings/insights-screen';

const ORG = '00000000-0000-4000-8000-000000000001';
const meeting = {
  id: '00000000-0000-4000-8000-0000000000aa',
  organizationId: ORG,
  title: 'Standup',
} as Meeting;

function setup(insights: DataSource['insights']) {
  const data = { ...createDataSource(null), insights };
  return render(
    <DataProvider value={data}>
      <InsightsScreen meeting={meeting} onBack={() => {}} />
    </DataProvider>,
  );
}

describe('InsightsScreen', () => {
  it('shows transcript segments with offsets', async () => {
    const t = {
      segments: [
        { id: 's1', index: 0, startMs: 65000, endMs: 70000, speaker: 'Asha', text: 'Ship it' },
      ],
    } as Transcript;
    setup({ transcript: vi.fn().mockResolvedValue(t), report: vi.fn() });
    expect(await screen.findByText('Ship it')).toBeTruthy();
    expect(screen.getByText('1:05')).toBeTruthy();
  });

  it('treats 404 as not ready yet, not an error', async () => {
    setup({
      transcript: vi.fn().mockRejectedValue(new AuthError('NOT_FOUND', 'x')),
      report: vi.fn(),
    });
    expect(await screen.findByText(/not ready yet/i)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows other errors as a toast with retry', async () => {
    const transcript = vi
      .fn()
      .mockRejectedValueOnce(new Error('Boom'))
      .mockResolvedValue({ segments: [] });
    setup({ transcript, report: vi.fn() });
    expect((await screen.findByRole('alert')).textContent).toContain('Boom');
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByText(/transcript is empty/i)).toBeTruthy();
  });

  it('loads the report tab on demand', async () => {
    const r = {
      summary: 'Agreed scope',
      decisions: ['Go'],
      risks: [],
      actionItems: [{ title: 'Write doc' }],
    } as unknown as Report;
    const report = vi.fn().mockResolvedValue(r);
    setup({ transcript: vi.fn().mockResolvedValue({ segments: [] }), report });
    expect(report).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('tab', { name: 'Report' }));
    expect(await screen.findByText('Agreed scope')).toBeTruthy();
    expect(screen.getByText('Write doc')).toBeTruthy();
  });

  it('formats long offsets', () => expect(formatOffset(3_725_000)).toBe('1:02:05'));
});
