import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckEmail, RESEND_COOLDOWN_SECONDS } from '@/features/auth/check-email';
import { PasswordField, PasswordStrength, scorePassword } from '@/features/auth/password';
import { createMockApi, renderApp, resetStores } from './fixtures/render';

describe('scorePassword', () => {
  it.each([
    ['', 0, 'Too short'],
    ['abcdefg', 1, 'Too short'],
    ['abcdefgh', 2, 'Weak'],
    ['correct-horse-battery', 2, 'Weak'],
    ['abcdefg1!', 3, 'Good'],
    ['Correct-Horse-Battery-9', 4, 'Strong'],
  ])('%j → %i %s', (pw, score, label) => {
    expect(scorePassword(pw)).toEqual({ score, label });
  });
});

describe('PasswordStrength', () => {
  it('announces the label politely and never uses the rose highlight', () => {
    const { container } = render(<PasswordStrength password="Correct-Horse-Battery-9" />);
    expect(screen.getByText('Strength: Strong')).toHaveAttribute('aria-live', 'polite');
    expect(container.innerHTML).not.toMatch(/highlight|rose/);
  });
});

describe('PasswordField', () => {
  it('toggles visibility with an accessible, pressed-state button', async () => {
    render(<PasswordField label="Password" name="password" />);
    const input = screen.getByLabelText('Password');
    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(input).toHaveAttribute('type', 'password');
    expect(toggle).toHaveAttribute('type', 'button');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(toggle).toHaveAttribute('aria-controls', 'password');
    await userEvent.click(toggle);
    expect(input).toHaveAttribute('type', 'text');
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('uses 44px, 16px-text inputs', () => {
    render(<PasswordField label="Password" name="password" />);
    expect(screen.getByLabelText('Password').className).toMatch(/\bh-11\b.*\btext-base\b/);
  });
});

describe('CheckEmail', () => {
  // Pure fake timers: with shouldAdvanceTime the 1 s cooldown tick also follows the wall clock, so on a busy box
  // (full `pnpm test`) a second of real time between the click and the assertion turned "60s" into "59s".
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('focuses the heading and enforces a 60s resend cooldown', async () => {
    const onResend = vi.fn().mockResolvedValue(undefined);
    render(<CheckEmail email="ada@example.com" message="to verify" onResend={onResend} />);
    expect(screen.getByRole('heading', { name: 'Check your inbox' })).toHaveFocus();
    expect(screen.getByRole('button', { name: /Resend in 60s/ })).toBeDisabled();
    // One act per tick: each second re-arms the timer from an effect.
    for (let i = 0; i < RESEND_COOLDOWN_SECONDS; i++) {
      await act(() => vi.advanceTimersByTimeAsync(1000));
    }
    const resend = screen.getByRole('button', { name: "Didn't get it? Resend" });
    expect(resend).toBeEnabled();
    // fireEvent inside act, not userEvent: RTL's async wrapper drains with a real setTimeout(0), which never fires
    // under pure fake timers. act flushes onResend's promise and the state update; no timer runs, so it is 60s.
    await act(async () => {
      fireEvent.click(resend);
    });
    expect(onResend).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: /Resend in 60s/ })).toBeDisabled();
  });
});

describe('AuthLayout', () => {
  beforeEach(() => resetStores(false));

  it('signup: split screen with the rich brand panel, one h1 and one shimmer CTA', async () => {
    const view = renderApp('/signup');
    await screen.findByRole('heading', { level: 1, name: 'Create your workspace' });
    await waitFor(() => expect(view.api.auth.providers).toHaveBeenCalled());
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const layout = screen.getByTestId('auth-layout');
    expect(layout.className).toContain('min-h-svh');
    const panel = screen.getByRole('complementary', { name: 'About MeetOps AI' });
    expect(panel).toHaveTextContent('Every meeting, turned into action.');
    expect(screen.getByTestId('mock-summary')).toBeInTheDocument();
    expect(layout.querySelectorAll('.shimmer, [class*="shimmer"]').length).toBeLessThanOrEqual(1);
    expect(screen.getByRole('button', { name: 'Create account' }).className).toMatch(/shimmer/);
    // Google stays hidden until the API says it is configured. No testimonials, ratings or trials.
    expect(screen.queryByRole('link', { name: 'Continue with Google' })).not.toBeInTheDocument();
    expect(layout).not.toHaveTextContent(/sso|trial|soc ?2|rating|★/i);
    expect(panel.querySelector('blockquote')).toBeNull();
  });

  it('login and signup show Continue with Google only when the API enables it', async () => {
    const api = createMockApi({
      auth: { providers: vi.fn().mockResolvedValue({ google: true }) },
    });
    const view = renderApp('/login?next=%2Fmeetings', api);
    const link = await screen.findByRole('link', { name: 'Continue with Google' });
    expect(link.getAttribute('href')).toContain('/auth/google/start');
    expect(link.getAttribute('href')).toContain('next=%2Fmeetings');
    expect(link.getAttribute('href')).not.toMatch(/secret|code_verifier|client_secret/i);
    view.unmount();

    renderApp('/signup', api);
    expect(await screen.findByRole('link', { name: 'Continue with Google' })).toHaveAttribute(
      'href',
      expect.stringContaining('/auth/google/start'),
    );
  });

  it('login: same shell, no mock summary, and sign-up keeps ?next=', async () => {
    renderApp('/login?next=%2Fmeetings');
    await screen.findByRole('heading', { level: 1, name: 'Welcome back' });
    const panel = screen.getByRole('complementary', { name: 'About MeetOps AI' });
    expect(panel).toHaveTextContent('Capture meetings and get a searchable transcript.');
    expect(screen.queryByTestId('mock-summary')).not.toBeInTheDocument();
    for (const name of ['Sign up', 'Create an account']) {
      expect(screen.getByRole('link', { name }).getAttribute('href')).toContain('next=%2Fmeetings');
    }
    expect(screen.getByRole('link', { name: 'Create an account' }).className).toMatch(/text-link/);
  });

  it('login shows a Google failure as a toast, not in the form', async () => {
    renderApp('/login?error=google');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Google sign-in didn't complete");
    expect(alert).toHaveTextContent('Try again, or use your password.');
    expect(screen.getByRole('heading', { level: 1, name: 'Welcome back' })).toBeInTheDocument();
  });

  it('B-1: an unverified account behind a Google email points to a password reset, not to verifying', async () => {
    renderApp('/login?error=google_unverified');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This email already has an unverified account');
    expect(alert).toHaveTextContent(
      "Reset its password from 'Forgot password', then try Google again.",
    );
    expect(alert.textContent ?? '').not.toMatch(/verify/i);
  });

  it('email-link pages use the same shell', async () => {
    renderApp('/verify-email');
    expect(await screen.findByTestId('link-problem')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'About MeetOps AI' })).toBeInTheDocument();
  });
});
