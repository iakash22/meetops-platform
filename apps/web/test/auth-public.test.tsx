import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/client';
import { useOrgStore } from '@/stores/org-store';
import { createMockApi, renderApp, resetStores } from './fixtures/render';

const TOKEN = 'tok_abcdefghijklmnopqrstuvwxyz0123456789';
const GLOBEX = '00000000-0000-4000-8000-000000000002';
const signedOut = () =>
  createMockApi({
    auth: { session: vi.fn().mockRejectedValue(new ApiError(401, 'UNAUTHENTICATED', 'no')) },
  });
const badToken = () => new ApiError(400, 'BAD_REQUEST', 'Invalid or expired token', 'req_1');

describe('/verify-email', () => {
  beforeEach(() => resetStores(false));

  it('does not verify on load; verifies the token from the link on confirm', async () => {
    const api = signedOut();
    renderApp(`/verify-email?token=${TOKEN}`, api);
    const button = await screen.findByRole('button', { name: 'Verify email' });
    expect(api.auth.verifyEmail).not.toHaveBeenCalled();
    await userEvent.click(button);
    expect(await screen.findByRole('status')).toHaveTextContent('Your email address is verified.');
    expect(api.auth.verifyEmail).toHaveBeenCalledWith({ token: TOKEN });
    expect(screen.getByRole('link', { name: 'Continue to sign in' })).toHaveAttribute(
      'href',
      '/login',
    );
  });

  it('explains an invalid or expired link (400) and offers a new one', async () => {
    const api = createMockApi({ auth: { verifyEmail: vi.fn().mockRejectedValue(badToken()) } });
    const { history } = renderApp(`/verify-email?token=${TOKEN}`, api);
    await userEvent.click(await screen.findByRole('button', { name: 'Verify email' }));
    expect(await screen.findByTestId('link-problem')).toHaveTextContent(/invalid or has expired/);
    expect(screen.getByRole('link', { name: 'Send a new verification link' })).toHaveAttribute(
      'href',
      '/resend-verification',
    );
    expect(history.location.pathname).toBe('/verify-email');
  });

  it('handles a link without a token', async () => {
    const api = signedOut();
    renderApp('/verify-email', api);
    expect(await screen.findByTestId('link-problem')).toHaveTextContent(/incomplete/);
    expect(screen.queryByRole('button', { name: 'Verify email' })).not.toBeInTheDocument();
  });

  it('shows a retryable error for other failures', async () => {
    const api = createMockApi({
      auth: {
        verifyEmail: vi
          .fn()
          .mockRejectedValueOnce(new ApiError(503, 'INTERNAL', 'down', 'req_2'))
          .mockResolvedValueOnce(undefined),
      },
    });
    renderApp(`/verify-email?token=${TOKEN}`, api);
    await userEvent.click(await screen.findByRole('button', { name: 'Verify email' }));
    expect(await screen.findByTestId('error-state')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Verify email' }));
    expect(await screen.findByRole('status')).toHaveTextContent('verified');
  });
});

describe('/reset-password', () => {
  beforeEach(() => resetStores(true));

  it('validates, submits the token + new password and clears local session state', async () => {
    const api = createMockApi();
    const { queryClient } = renderApp(`/reset-password?token=${TOKEN}`, api);
    await userEvent.type(await screen.findByLabelText('New password'), 'short');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'other');
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByText('Password must be at least 12 characters')).toBeInTheDocument();
    expect(screen.getByText('Passwords do not match')).toBeInTheDocument();
    expect(api.auth.resetPassword).not.toHaveBeenCalled();

    await userEvent.clear(screen.getByLabelText('New password'));
    await userEvent.type(screen.getByLabelText('New password'), 'long-enough-pass');
    await userEvent.clear(screen.getByLabelText('Confirm new password'));
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'long-enough-pass');
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }));

    expect(await screen.findByRole('status')).toHaveTextContent(/signed out on every device/);
    expect(api.auth.resetPassword).toHaveBeenCalledWith({
      token: TOKEN,
      password: 'long-enough-pass',
    });
    expect(queryClient.getQueryData(['session'])).toBeNull();
    expect(useOrgStore.getState().currentOrganizationId).toBeNull();
    expect(screen.getByRole('link', { name: 'Sign in with your new password' })).toHaveAttribute(
      'href',
      '/login',
    );
  });

  it('explains an invalid or expired link (400) and links to forgot-password', async () => {
    const api = createMockApi({ auth: { resetPassword: vi.fn().mockRejectedValue(badToken()) } });
    renderApp(`/reset-password?token=${TOKEN}`, api);
    await userEvent.type(await screen.findByLabelText('New password'), 'long-enough-pass');
    await userEvent.type(screen.getByLabelText('Confirm new password'), 'long-enough-pass');
    await userEvent.click(screen.getByRole('button', { name: 'Set new password' }));
    expect(await screen.findByTestId('link-problem')).toHaveTextContent(/invalid or has expired/);
    expect(screen.getByRole('link', { name: 'Request a new reset link' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
    expect(useOrgStore.getState().currentOrganizationId).not.toBeNull();
  });

  it('rejects a missing or oversized token without showing the form', async () => {
    renderApp(`/reset-password?token=${'x'.repeat(513)}`, signedOut());
    expect(await screen.findByTestId('link-problem')).toHaveTextContent(/incomplete/);
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
  });
});

describe('/resend-verification', () => {
  beforeEach(() => resetStores(false));

  it('prefills ?email= and shows the same confirmation on success', async () => {
    const api = signedOut();
    renderApp('/resend-verification?email=ada%40example.com', api);
    expect(await screen.findByLabelText('Email')).toHaveValue('ada@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send verification link' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/a new link is on its way/);
    expect(api.auth.resendVerification).toHaveBeenCalledWith({ email: 'ada@example.com' });
  });

  it('validates the email and stays enumeration-safe on failure', async () => {
    const api = createMockApi({
      auth: {
        session: vi.fn().mockRejectedValue(new ApiError(401, 'UNAUTHENTICATED', 'no')),
        resendVerification: vi.fn().mockRejectedValue(new ApiError(429, 'RATE_LIMITED', 'x')),
      },
    });
    renderApp('/resend-verification', api);
    await userEvent.click(await screen.findByRole('button', { name: 'Send verification link' }));
    expect(await screen.findByText('Email is required')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send verification link' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/a new link is on its way/);
  });
});

describe('/invitations/accept', () => {
  beforeEach(() => resetStores(true));

  it('signed out: asks to sign in and keeps the invitation link in ?next=', async () => {
    const api = signedOut();
    renderApp(`/invitations/accept?token=${TOKEN}`, api);
    const signIn = await screen.findByRole('link', { name: 'Sign in to accept' });
    const next = new URL(signIn.getAttribute('href')!, 'http://x').searchParams.get('next');
    expect(next).toBe(`/invitations/accept?token=${TOKEN}`);
    expect(api.invitations.accept).not.toHaveBeenCalled();
  });

  it('signed in: accepts on confirm, switches into the org, refetches the session', async () => {
    const api = createMockApi();
    const { history } = renderApp(`/invitations/accept?token=${TOKEN}`, api);
    expect(await screen.findByText('ada@example.com')).toBeInTheDocument();
    expect(api.invitations.accept).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Accept invitation' }));
    await waitFor(() => expect(history.location.pathname).toBe('/'));
    expect(api.invitations.accept).toHaveBeenCalledWith({ token: TOKEN });
    expect(api.organizations.switch).toHaveBeenCalledWith({ organizationId: GLOBEX });
    expect(vi.mocked(api.auth.session).mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(useOrgStore.getState().currentOrganizationId).toBe(GLOBEX);
  });

  it.each([
    [404, 'NOT_FOUND', /can't be used/],
    [403, 'FORBIDDEN', /Verify your email first/],
    [409, 'CONFLICT', /already a member/],
  ] as const)('maps %i %s to a clear message', async (status, code, text) => {
    const api = createMockApi({
      invitations: { accept: vi.fn().mockRejectedValue(new ApiError(status, code, 'x', 'r')) },
    });
    const { history } = renderApp(`/invitations/accept?token=${TOKEN}`, api);
    await userEvent.click(await screen.findByRole('button', { name: 'Accept invitation' }));
    expect(await screen.findByTestId('link-problem')).toHaveTextContent(text);
    expect(api.organizations.switch).not.toHaveBeenCalled();
    expect(history.location.pathname).toBe('/invitations/accept');
  });

  it('handles a link without a token', async () => {
    renderApp('/invitations/accept', createMockApi());
    expect(await screen.findByTestId('link-problem')).toHaveTextContent(/incomplete/);
    expect(screen.queryByRole('button', { name: 'Accept invitation' })).not.toBeInTheDocument();
  });
});
