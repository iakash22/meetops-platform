import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckEmail, RESEND_COOLDOWN_SECONDS } from '@/features/auth/check-email';
import { PasswordField, PasswordStrength, scorePassword } from '@/features/auth/password';
import { renderApp, resetStores } from './fixtures/render';

describe('scorePassword', () => {
  it.each([
    ['', 0, 'Too short'],
    ['a'.repeat(11), 1, 'Too short'],
    ['aaaaaaaaaaaa', 2, 'Weak'],
    ['correct-horse-battery', 3, 'Good'],
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
    renderApp('/signup');
    await screen.findByRole('heading', { level: 1, name: 'Create your workspace' });
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const layout = screen.getByTestId('auth-layout');
    expect(layout.className).toContain('min-h-svh');
    const panel = screen.getByRole('complementary', { name: 'About MeetOps AI' });
    expect(panel).toHaveTextContent('Every meeting, turned into action.');
    expect(screen.getByTestId('mock-summary')).toBeInTheDocument();
    expect(layout.querySelectorAll('.shimmer, [class*="shimmer"]').length).toBeLessThanOrEqual(1);
    expect(screen.getByRole('button', { name: 'Create account' }).className).toMatch(/shimmer/);
    // No SSO, testimonials, ratings, trials or security claims.
    expect(layout).not.toHaveTextContent(/google|sso|trial|soc ?2|rating|★/i);
    expect(panel.querySelector('blockquote')).toBeNull();
  });

  it('login: same shell, quieter panel (no mock summary)', async () => {
    renderApp('/login');
    await screen.findByRole('heading', { level: 1, name: 'Welcome back' });
    expect(screen.getByRole('complementary', { name: 'About MeetOps AI' })).toBeInTheDocument();
    expect(screen.queryByTestId('mock-summary')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Create an account' }).className).toMatch(/text-link/);
  });

  it('email-link pages use the same shell', async () => {
    renderApp('/verify-email');
    expect(await screen.findByTestId('link-problem')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: 'About MeetOps AI' })).toBeInTheDocument();
  });
});
