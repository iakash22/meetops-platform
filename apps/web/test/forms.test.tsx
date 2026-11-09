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
  it('signup has no confirm-password field', () => {
    const r = signupSchema.safeParse({ name: 'A', email: 'a@b.co', password: 'Abcdef1!' });
    expect(r.success).toBe(true);
  });
  it('validates forgot password email', () => {
    expect(forgotPasswordSchema.safeParse({ email: '' }).success).toBe(false);
  });
  // zod 4 + @hookform/resolvers v5: pin the user-facing messages so the migration keeps v3 UX.
  const emailMessages = (email: string) => {
    const r = forgotPasswordSchema.safeParse({ email });
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };
  it('reports only "Email is required" for an empty email', () => {
    expect(emailMessages('')).toEqual(['Email is required']);
  });
  it('reports "Enter a valid email" for a malformed email', () => {
    expect(emailMessages('bad')).toEqual(['Enter a valid email']);
    expect(emailMessages('a@b.co')).toEqual([]);
  });
});

describe('auth forms', () => {
  beforeEach(() => resetStores(false));

  it('shows validation errors on empty login submit', async () => {
    const { api } = renderApp('/login');
    await screen.findByLabelText('Email');
    await userEvent.click(await screen.findByRole('button', { name: 'Log in' }));
    expect(await screen.findByText('Email is required')).toBeInTheDocument();
    expect(await screen.findByText('Password is required')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toHaveAttribute('aria-invalid', 'true');
    expect(api.auth.login).not.toHaveBeenCalled();
  });

  it('logs in, stores orgs and navigates to the dashboard', async () => {
    const { api, history } = renderApp('/login');
    await userEvent.type(await screen.findByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(history.location.pathname).toBe('/'));
    expect(api.auth.login).toHaveBeenCalledWith({ email: 'ada@example.com', password: 'secret' });
    expect(useOrgStore.getState().currentOrganizationId).toBe(
      '00000000-0000-4000-8000-000000000001',
    );
  });

  it('wrong credentials: inline under the password, email kept, password cleared + focused', async () => {
    renderApp(
      '/login',
      createMockApi({
        auth: {
          login: vi
            .fn()
            .mockRejectedValue(new ApiError(401, 'AUTH_FAILED', 'Invalid email or password', 'r')),
        },
      }),
    );
    await userEvent.type(await screen.findByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    const password = screen.getByLabelText('Password');
    await waitFor(() => expect(password).toHaveAttribute('aria-invalid', 'true'));
    expect(password).toHaveValue('');
    expect(password).toHaveFocus();
    expect(password).toHaveAttribute('aria-describedby', 'password-error');
    expect(screen.getByText('Email or password is incorrect.')).toHaveAttribute(
      'id',
      'password-error',
    );
    expect(screen.getByLabelText('Email')).toHaveValue('ada@example.com');
    // Inline only: no toast for a field error.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('login errors not tied to a field go to a toast', async () => {
    renderApp(
      '/login',
      createMockApi({
        auth: {
          login: vi.fn().mockRejectedValue(new ApiError(503, 'PROVIDER_UNAVAILABLE', 'down')),
        },
      }),
    );
    await userEvent.type(await screen.findByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Can't reach MeetOps right now");
    expect(screen.getByLabelText('Password')).not.toHaveAttribute('aria-invalid');
  });

  it('login uses the right autocomplete + input attributes and a post form', async () => {
    renderApp('/login');
    const email = await screen.findByLabelText('Email');
    expect(email).toHaveAttribute('autocomplete', 'username');
    expect(email).toHaveAttribute('inputmode', 'email');
    expect(email).toHaveAttribute('autocapitalize', 'none');
    expect(email).toHaveAttribute('spellcheck', 'false');
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password');
    expect(email.closest('form')).toHaveAttribute('method', 'post');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('link', { name: 'Forgot password?' })).toHaveAttribute(
      'href',
      '/forgot-password',
    );
  });

  it('validates and submits signup (no confirm field)', async () => {
    const { api, history, queryClient } = renderApp('/signup');
    expect(screen.queryByLabelText(/confirm/i)).not.toBeInTheDocument();
    await userEvent.type(await screen.findByLabelText('Full name'), 'Ada');
    await userEvent.type(screen.getByLabelText('Work email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'short');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(
      await screen.findByText('Use 8 or more characters with a letter, a number, and a symbol.'),
    ).toBeInTheDocument();

    await userEvent.clear(screen.getByLabelText('Password'));
    await userEvent.type(screen.getByLabelText('Password'), 'Long-enough-1');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await waitFor(() =>
      expect(api.auth.signup).toHaveBeenCalledWith({
        name: 'Ada',
        email: 'ada@example.com',
        password: 'Long-enough-1',
      }),
    );
    // 202 { message }: no session — show "check your inbox", do not sign in.
    const heading = await screen.findByRole('heading', { name: 'Check your inbox' });
    expect(heading).toHaveFocus();
    expect(screen.getByTestId('check-email')).toHaveAttribute('role', 'status');
    expect(screen.getByTestId('check-email')).toHaveTextContent('ada@example.com');
    expect(history.location.pathname).toBe('/signup');
    expect(queryClient.getQueryData(['session'])).toBeFalsy();
    expect(useOrgStore.getState().currentOrganizationId).toBeNull();
    expect(api.auth.login).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Open Gmail' })).toHaveAttribute(
      'href',
      'https://mail.google.com/',
    );
    // Resend starts on a 60s cooldown.
    expect(screen.getByRole('button', { name: /Resend in \d+s/ })).toBeDisabled();
  });

  it('"Use a different email" goes back to the form with the fields prefilled', async () => {
    renderApp('/signup');
    await userEvent.type(await screen.findByLabelText('Full name'), 'Ada');
    await userEvent.type(screen.getByLabelText('Work email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'Long-enough-1');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Use a different email' }));
    expect(screen.getByLabelText('Full name')).toHaveValue('Ada');
    expect(screen.getByLabelText('Work email')).toHaveValue('ada@example.com');
  });

  it('signup carries ?next= to the log in link', async () => {
    renderApp('/signup?next=%2Fmeetings');
    await userEvent.type(await screen.findByLabelText('Full name'), 'Ada');
    await userEvent.type(screen.getByLabelText('Work email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'Long-enough-1');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    await screen.findByRole('heading', { name: 'Check your inbox' });
    expect(screen.getByRole('link', { name: 'Log in' })).toHaveAttribute(
      'href',
      '/login?next=%2Fmeetings',
    );
  });

  it('signup: API validation details render inline under the matching field', async () => {
    const api = createMockApi({
      auth: {
        signup: vi.fn().mockRejectedValue(
          ApiError.fromResponse(400, {
            error: {
              code: 'VALIDATION_FAILED',
              message: 'server text',
              details: [{ path: '/email', message: 'invalid' }],
            },
          }),
        ),
      },
    });
    renderApp('/signup', api);
    await userEvent.type(await screen.findByLabelText('Full name'), 'Ada');
    await userEvent.type(screen.getByLabelText('Work email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'Long-enough-1');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    const email = screen.getByLabelText('Work email');
    await waitFor(() => expect(email).toHaveAttribute('aria-invalid', 'true'));
    expect(screen.getByText('Enter a valid email address.')).toBeInTheDocument();
    expect(screen.queryByText('server text')).not.toBeInTheDocument();
  });

  it('signup: 429 goes to a toast and stays on the form', async () => {
    const api = createMockApi({
      auth: {
        signup: vi.fn().mockRejectedValue(new ApiError(429, 'RATE_LIMITED', 'slow down', 'req_2')),
      },
    });
    renderApp('/signup', api);
    await userEvent.type(await screen.findByLabelText('Full name'), 'Ada');
    await userEvent.type(screen.getByLabelText('Work email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'Long-enough-1');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Too many attempts');
    expect(alert).toHaveTextContent(ERROR_MESSAGES.RATE_LIMITED);
    expect(screen.queryByRole('heading', { name: 'Check your inbox' })).not.toBeInTheDocument();
  });

  it('signup: CSRF failure (after the client refetch) toasts "Session expired"', async () => {
    const api = createMockApi({
      auth: {
        signup: vi.fn().mockRejectedValue(new ApiError(403, 'CSRF_INVALID', 'csrf', 'r')),
      },
    });
    renderApp('/signup', api);
    await userEvent.type(await screen.findByLabelText('Full name'), 'Ada');
    await userEvent.type(screen.getByLabelText('Work email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'Long-enough-1');
    await userEvent.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Session expired, please try again');
  });

  it('submits forgot password and shows the check-your-inbox state', async () => {
    const { api } = renderApp('/forgot-password');
    await userEvent.type(await screen.findByLabelText('Email'), 'nobody@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByRole('heading', { name: 'Check your inbox' })).toBeInTheDocument();
    // Enumeration-safe copy: never says whether the account exists.
    expect(screen.getByTestId('check-email')).toHaveTextContent(
      /If nobody@example.com can receive it/,
    );
    expect(api.auth.forgotPassword).toHaveBeenCalledWith({ email: 'nobody@example.com' });
  });

  it('forgot password: a transport failure toasts and stays on the form', async () => {
    renderApp(
      '/forgot-password',
      createMockApi({
        auth: { forgotPassword: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) },
      }),
    );
    await userEvent.type(await screen.findByLabelText('Email'), 'ada@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Send reset link' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Can't reach MeetOps right now");
    expect(screen.queryByRole('heading', { name: 'Check your inbox' })).not.toBeInTheDocument();
  });
});

describe('password rules', () => {
  it('login accepts any non-empty password', () => {
    expect(loginSchema.safeParse({ email: 'a@b.co', password: 'x' }).success).toBe(true);
    expect(loginSchema.safeParse({ email: 'a@b.co', password: '' }).success).toBe(false);
  });
  it('signup requires 8 or more characters with a letter, number, and symbol', () => {
    const base = { name: 'A', email: 'a@b.co' };
    const pw = (p: string) => signupSchema.safeParse({ ...base, password: p }).success;
    expect(pw('Abcde1!')).toBe(false);
    expect(pw('abcdefgh')).toBe(false);
    expect(pw('Abcdefg1')).toBe(false);
    expect(pw('Abcdefg!')).toBe(false);
    expect(pw('Abcdef1!')).toBe(true);
    expect(pw(`Ab1!${'a'.repeat(124)}`)).toBe(true);
    expect(pw(`Ab1!${'a'.repeat(125)}`)).toBe(false);
  });
});

describe('login ?next= redirect', () => {
  beforeEach(() => resetStores(false));

  async function login() {
    await userEvent.type(await screen.findByLabelText('Email'), 'ada@example.com');
    await userEvent.type(screen.getByLabelText('Password'), 'x');
    await userEvent.click(screen.getByRole('button', { name: 'Log in' }));
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
