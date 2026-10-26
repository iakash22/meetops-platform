import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/client';
import { isEmailUnverified } from '@/features/session/verify-banner';
import { createMockApi, renderApp, resetStores } from './fixtures/render';
import { sessionResponse } from './fixtures/data';

function unverifiedApi() {
  const api = createMockApi();
  (api.auth.session as ReturnType<typeof vi.fn>).mockResolvedValue({
    ...sessionResponse,
    user: { ...sessionResponse.user, emailVerifiedAt: null },
  });
  return api;
}

describe('verify email banner', () => {
  beforeEach(() => resetStores());

  it('only flags an explicit null emailVerifiedAt', () => {
    expect(isEmailUnverified({ emailVerifiedAt: null })).toBe(true);
    expect(isEmailUnverified({ emailVerifiedAt: '2026-10-01T00:00:00.000Z' })).toBe(false);
    expect(isEmailUnverified({})).toBe(false);
    expect(isEmailUnverified(null)).toBe(false);
  });

  it('is hidden while the session has no verification field', async () => {
    renderApp('/');
    expect(await screen.findByTestId('app-shell')).toBeInTheDocument();
    expect(screen.queryByTestId('verify-email-banner')).not.toBeInTheDocument();
  });

  it('resends with a cooldown, and dismisses', async () => {
    const api = unverifiedApi();
    renderApp('/', api);
    const btn = await screen.findByRole('button', { name: 'Resend link' });
    await userEvent.click(btn);
    await waitFor(() =>
      expect(api.auth.resendVerification).toHaveBeenCalledWith({
        email: sessionResponse.user.email,
      }),
    );
    expect(await screen.findByText('Verification email sent')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Resend in \d+s/ })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('verify-email-banner')).not.toBeInTheDocument();
  });

  it('shows a toast when resending fails', async () => {
    const api = unverifiedApi();
    (api.auth.resendVerification as ReturnType<typeof vi.fn>).mockRejectedValue(
      new ApiError(429, 'RATE_LIMITED', 'slow down'),
    );
    renderApp('/', api);
    await userEvent.click(await screen.findByRole('button', { name: 'Resend link' }));
    expect(await screen.findByText("Couldn't send the email")).toBeInTheDocument();
  });
});
