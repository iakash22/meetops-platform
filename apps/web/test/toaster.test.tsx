import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { AppToaster, dismissAllToasts, showToast } from '@/lib/errors/toaster';

describe('AppToaster (sonner)', () => {
  afterEach(() => act(() => dismissAllToasts()));

  it('renders errors as alerts and others as status, with brand colours and dismiss', async () => {
    render(<AppToaster />);
    act(() => {
      showToast('error', 'Could not save', { description: 'Try again.' });
      showToast('success', 'Saved');
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not save');
    expect(alert).toHaveTextContent('Try again.');
    expect(alert.className).toContain('bg-[#141416]');
    expect(alert.className).not.toMatch(/rose|FF2D95/i);
    const status = await screen.findByText('Saved');
    expect(status.closest('[role="status"]')).toHaveAttribute('data-variant', 'success');
    expect(screen.getByLabelText(/^Notifications/)).toBeInTheDocument();
    await userEvent.click(within(alert).getByRole('button', { name: 'Dismiss notification' }));
    await waitFor(() => expect(screen.queryByText('Could not save')).toBeNull(), {
      timeout: 3000,
    });
  });
});
