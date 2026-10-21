import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useOrgStore } from '@/stores/org-store';
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
      password: '12345678',
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
    expect(useOrgStore.getState().currentOrgId).toBe('org_1');
  });

  it('shows a submit error when login fails', async () => {
    renderApp(
      '/login',
      createMockApi({
        auth: { login: vi.fn().mockRejectedValue(new Error('Invalid credentials')) },
      }),
    );
    await userEvent.type(await screen.findByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByTestId('error-state')).toHaveTextContent('Invalid credentials');
  });

  it('validates and submits signup', async () => {
    const { api } = renderApp('/signup');
    await userEvent.type(await screen.findByLabelText('Name'), 'Ada');
    await userEvent.type(screen.getByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'short');
    await userEvent.type(screen.getByLabelText('Confirm password'), 'different');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Password must be at least 8 characters')).toBeInTheDocument();
    expect(screen.getByText('Passwords do not match')).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText('Password'));
    await userEvent.type(screen.getByLabelText('Password'), 'longenough');
    await userEvent.clear(screen.getByLabelText('Confirm password'));
    await userEvent.type(screen.getByLabelText('Confirm password'), 'longenough');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() =>
      expect(api.auth.signup).toHaveBeenCalledWith({
        name: 'Ada',
        email: 'ada@example.com',
        password: 'longenough',
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
});
