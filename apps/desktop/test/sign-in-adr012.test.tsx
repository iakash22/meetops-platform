import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { App } from '@/app';
import { createUnavailableAuthClient } from '@/features/auth/unavailable-auth';
import { isMockAuthEnabled } from '@/lib/config';

describe('ADR-012 desktop sign-in', () => {
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

  it('mock flag: explicit env wins, otherwise DEV only', () => {
    const env = (e: Partial<ImportMetaEnv>) => e as ImportMetaEnv;
    expect(isMockAuthEnabled(env({ DEV: false }))).toBe(false);
    expect(isMockAuthEnabled(env({ DEV: true }))).toBe(true);
    expect(isMockAuthEnabled(env({ DEV: false, VITE_DESKTOP_MOCK_AUTH: 'true' }))).toBe(true);
    expect(isMockAuthEnabled(env({ DEV: true, VITE_DESKTOP_MOCK_AUTH: 'false' }))).toBe(false);
  });
});
