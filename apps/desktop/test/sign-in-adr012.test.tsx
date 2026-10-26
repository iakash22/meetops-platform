import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from '@/app';
import { SessionProvider } from '@/features/auth/session';
import { SignInScreen } from '@/features/auth/sign-in-screen';
import { createUnavailableAuthClient } from '@/features/auth/unavailable-auth';
import { isMockAuthEnabled } from '@/lib/config';

describe('ADR-012 desktop sign-in', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('production build: App ignores VITE_DESKTOP_MOCK_AUTH=true and the mockAuth prop', () => {
    vi.stubEnv('DEV', false);
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_DESKTOP_MOCK_AUTH', 'true');
    render(<App mockAuth />);
    expect(screen.queryByRole('form', { name: 'Sign in' })).not.toBeInTheDocument();
    expect(screen.queryByText(/sign-in is mocked/i)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign in with your browser/i })).toBeDisabled();
  });

  it('shows a disabled browser sign-in button explained as pending', () => {
    render(<App mockAuth={false} />);
    const btn = screen.getByRole('button', { name: /sign in with your browser/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAccessibleDescription(/not available yet/i);
  });

  it('hides the password form, mock footer and sign-up when the mock is off', () => {
    render(<App mockAuth={false} />);
    expect(screen.queryByRole('form', { name: 'Sign in' })).not.toBeInTheDocument();
    expect(screen.queryByText(/sign-in is mocked/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /create an account/i })).not.toBeInTheDocument();
  });

  it('shows the labelled mock preview form when the mock is on', () => {
    render(<App mockAuth />);
    expect(screen.getByRole('form', { name: 'Sign in' })).toBeInTheDocument();
    expect(screen.getByText(/sign-in is mocked/i)).toBeInTheDocument();
  });

  it('unavailable client fails closed and never returns a session', async () => {
    await expect(
      createUnavailableAuthClient().signIn({ email: 'a@b.co', password: 'x'.repeat(12) }),
    ).rejects.toThrow(/not available/i);
  });

  it('mock flag is hard-off in production: VITE_DESKTOP_MOCK_AUTH=true is ignored when PROD', () => {
    const env = (e: Partial<ImportMetaEnv>) => e as ImportMetaEnv;
    expect(isMockAuthEnabled(env({ DEV: false, PROD: true }))).toBe(false);
    expect(isMockAuthEnabled(env({ DEV: false, PROD: true, VITE_DESKTOP_MOCK_AUTH: 'true' }))).toBe(
      false,
    );
    expect(isMockAuthEnabled(env({ DEV: true, PROD: false }))).toBe(true);
    expect(isMockAuthEnabled(env({ DEV: true, VITE_DESKTOP_MOCK_AUTH: 'false' }))).toBe(false);
  });

  it('SignInScreen fails closed: no mock form unless mockAuth is passed', () => {
    render(
      <SessionProvider client={createUnavailableAuthClient()}>
        <SignInScreen />
      </SessionProvider>,
    );
    expect(screen.queryByRole('form', { name: 'Sign in' })).not.toBeInTheDocument();
    expect(screen.queryByText(/sign-in is mocked/i)).not.toBeInTheDocument();
  });
});
