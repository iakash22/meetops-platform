import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useOrgStore } from '@/stores/org-store';
import { ApiError } from '@/lib/api/client';
import { ERROR_MESSAGES } from '@/lib/api/error-messages';
import { forgotPasswordSchema, loginSchema, signupSchema } from '@/features/auth/schemas';
import { createMockApi, renderApp, resetStores } from './fixtures/render';

describe('auth schemas', () => {
  it('validates login', () => {
    expect(loginSchema.safeParse({ email: 'bad', password: '' }).success).toBe(false);
    expect(loginSchema.safeParse({ email: 'a@b.co', password: 'x' }).success).toBe(true);
  });
  it('requires matching signup passwords', () => {
    const r = signupSchema.safeParse({
      name: 'A',
      email: 'a@b.co',
      password: '123456789012',
      confirmPassword: 'nope',
    });
    expect(r.success).toBe(false);
  });
  it('validates forgot password email', () => {
    expect(forgotPasswordSchema.safeParse({ email: '' }).success).toBe(false);
  });
});

describe('auth forms', () => {
  beforeEach(() => resetStores(false));

  it('shows validation errors on empty login submit', async () => {
    const { api } = renderApp('/login');
    await userEvent.click(await screen.findByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Email is required')).toBeInTheDocument();
    expect(screen.getByText('Password is required')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(api.auth.login).not.toHaveBeenCalled();
  });

  it('logs in, stores orgs and navigates to the dashboard', async () => {
    const { api, history } = renderApp('/login');
    await userEvent.type(await screen.findByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    await waitFor(() => expect(history.location.pathname).toBe('/'));
    expect(api.auth.login).toHaveBeenCalledWith({ email: 'ada@example.com', password: 'secret' });
    expect(useOrgStore.getState().currentOrganizationId).toBe('org_1');
  });

  it('shows a submit error when login fails', async () => {
    renderApp(
      '/login',
      createMockApi({
        auth: {
          login: vi
            .fn()
            .mockRejectedValue(
              new ApiError(401, 'UNAUTHENTICATED', 'Invalid email or password', 'req_9'),
            ),
        },
      }),
    );
    await userEvent.type(await screen.findByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByTestId('error-state')).toHaveTextContent(
      ERROR_MESSAGES.UNAUTHENTICATED,
    );
  });

  it('validates and submits signup', async () => {
    const { api } = renderApp('/signup');
    await userEvent.type(await screen.findByLabelText('Name'), 'Ada');
    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'short');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'different');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Password must be at least 12 characters')).toBeInTheDocument();
    expect(screen.getByText('Passwords do not match')).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText('Password'));
    await userEvent.type(screen.getByLabelText('Password'), 'long-enough-pass');
    await userEvent.clear(screen.getByLabelText('Confirm password'));
    await userEvent.type(screen.getByLabelText('Confirm password'), 'long-enough-pass');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() =>
      expect(api.auth.signup).toHaveBeenCalledWith({
        name: 'Ada',
        email: 'ada@example.com',
        password: 'long-enough-pass',
      }),
    );
  });

  it('submits forgot password and shows confirmation', async () => {
    const { api } = renderApp('/forgot-password');
    await userEvent.type(await screen.findByLabelText('Email'), 'ada@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText(/reset link is on its way/)).toBeInTheDocument();
    expect(api.auth.forgotPassword).toHaveBeenCalledWith({ email: 'ada@example.com' });
  });

  it('forgot password shows the same success message even when the request fails', async () => {
    renderApp(
      '/forgot-password',
      createMockApi({
        auth: {
          forgotPassword: vi.fn().mockRejectedValue(new ApiError(404, 'NOT_FOUND', 'no user')),
        },
      }),
    );
    await userEvent.type(await screen.findByLabelText('Email'), 'nobody@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByText(/reset link is on its way/)).toBeInTheDocument();
    expect(screen.queryByTestId('error-state')).not.toBeInTheDocument();
  });
});

describe('password rules', () => {
  it('login accepts any non-empty password', () => {
    expect(loginSchema.safeParse({ email: 'a@b.co', password: 'x' }).success).toBe(true);
    expect(loginSchema.safeParse({ email: 'a@b.co', password: '' }).success).toBe(false);
  });
  it('signup requires 12 to 128 characters', () => {
    const base = { name: 'A', email: 'a@b.co' };
    const pw = (p: string) =>
      signupSchema.safeParse({ ...base, password: p, confirmPassword: p }).success;
    expect(pw('a'.repeat(11))).toBe(false);
    expect(pw('a'.repeat(12))).toBe(true);
    expect(pw('a'.repeat(128))).toBe(true);
    expect(pw('a'.repeat(129))).toBe(false);
  });
});

describe('login ?next= redirect', () => {
  beforeEach(() => resetStores(false));

  async function login() {
    await userEvent.type(await screen.findByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  }

  it('goes to a safe ?next= path after login', async () => {
    const { history } = renderApp('/login?next=%2Ftasks%3Fstatus%3Ddone');
    await login();
    await waitFor(() => expect(history.location.href).toBe('/tasks?status=done'));
  });

  it.each(['//evil.com', 'https://evil.com', '/%2F%2Fevil.com', '/%5Cevil'])(
    'ignores unsafe ?next=%s and goes to /',
    async (next) => {
      const { history } = renderApp(`/login?next=${encodeURIComponent(next)}`);
      await login();
      await waitFor(() => expect(history.location.pathname).toBe('/'));
    },
  );
});
