import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { App } from '@/app';
import type { AuthClient } from '@/features/auth/auth-client';
import { createMockAuthClient } from '@/features/auth/mock-auth';
import { validateSignUp } from '@/features/auth/sign-up-screen';

function renderApp(client: AuthClient = createMockAuthClient({ delayMs: 0 })) {
  const user = userEvent.setup();
  render(<App authClient={client} />);
  return user;
}

async function openSignUp(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Create an account' }));
  expect(await screen.findByRole('form', { name: 'Sign up' })).toBeInTheDocument();
}

async function fill(
  user: ReturnType<typeof userEvent.setup>,
  {
    name = 'Alex Rivera',
    email = 'alex@example.com',
    password = 'Correct-horse-1',
  }: { name?: string; email?: string; password?: string } = {},
) {
  if (name) await user.type(screen.getByLabelText('Name'), name);
  if (email) await user.type(screen.getByLabelText('Email'), email);
  if (password) await user.type(screen.getByLabelText('Password'), password);
}

const submit = (user: ReturnType<typeof userEvent.setup>) =>
  user.click(screen.getByRole('button', { name: 'Create account' }));

describe('desktop sign-up', () => {
  it('links from sign-in to sign-up and back', async () => {
    const user = renderApp();
    await openSignUp(user);
    expect(screen.getByText(/sign-up is mocked/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(screen.getByRole('form', { name: 'Sign in' })).toBeInTheDocument();
  });

  it('shows inline errors under each empty field without calling the client', async () => {
    const client = createMockAuthClient({ delayMs: 0 });
    const spy = vi.spyOn(client, 'signUp');
    const user = renderApp(client);
    await openSignUp(user);
    await submit(user);
    expect(screen.getByLabelText('Name')).toHaveAccessibleDescription('Enter your name.');
    expect(screen.getByLabelText('Email')).toHaveAccessibleDescription('Enter your email.');
    expect(screen.getByLabelText('Password')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Create a password.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Confirm password')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveFocus();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it('flags a short password inline and focuses it', async () => {
    const user = renderApp();
    await openSignUp(user);
    await fill(user, { password: 'short' });
    await submit(user);
    expect(
      screen.getByText('Use 8 or more characters with a letter, a number, and a symbol.'),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toHaveFocus();
  });

  it('rates password strength', async () => {
    const user = renderApp();
    await openSignUp(user);
    expect(screen.getByRole('img', { name: 'Password strength: Too short' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Password'), 'aaaaaaaaaaaa');
    expect(screen.getByRole('img', { name: 'Password strength: Weak' })).toBeInTheDocument();
    await user.type(screen.getByLabelText('Password'), 'A-9-bcdefgh');
    expect(screen.getByRole('img', { name: 'Password strength: Strong' })).toBeInTheDocument();
  });

  it('clears a field error as soon as the field is edited', async () => {
    const user = renderApp();
    await openSignUp(user);
    await submit(user);
    await user.type(screen.getByLabelText('Name'), 'A');
    expect(screen.queryByText('Enter your name.')).not.toBeInTheDocument();
    expect(screen.getByText('Enter your email.')).toBeInTheDocument();
  });

  it('shows the password policy hint and toggles password visibility', async () => {
    const user = renderApp();
    await openSignUp(user);
    const hint = screen.getByText(/letter, number, and symbol/);
    expect(hint).toHaveTextContent('(not met yet)');
    await user.type(screen.getByLabelText('Password'), 'Abcdef1!');
    expect(hint).toHaveTextContent('(met)');

    const toggle = screen.getByRole('button', { name: 'Show password' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'password');
    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByLabelText('Password')).toHaveAttribute('type', 'text');
  });

  it('ends on check-your-email for a taken email (enumeration-safe)', async () => {
    const user = renderApp();
    await openSignUp(user);
    await fill(user, { email: 'alex@taken.test' });
    await submit(user);
    expect(await screen.findByRole('status', { name: 'Check your email' })).toBeInTheDocument();
    expect(screen.queryByText(/already exists/)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows non-field errors in a dismissible toast', async () => {
    const user = renderApp();
    await openSignUp(user);
    await fill(user, { email: 'alex@unavailable.test' });
    await submit(user);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Sign-up is unavailable right now. Try again shortly.',
    );
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the check-your-email state without signing in, then returns to sign-in', async () => {
    const user = renderApp();
    await openSignUp(user);
    await fill(user, { email: 'Alex@Example.com' });
    await submit(user);
    const status = await screen.findByRole('status', { name: 'Check your email' });
    expect(status).toHaveTextContent('alex@example.com');
    expect(screen.queryByRole('list', { name: 'Meetings' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to sign in' }));
    expect(screen.getByRole('form', { name: 'Sign in' })).toBeInTheDocument();
  });
});

describe('validateSignUp', () => {
  const ok = { name: 'A', email: 'a@b.co', password: 'Correct-1!' };
  it('accepts a valid request', () => {
    expect(validateSignUp(ok)).toEqual({});
  });
  it('enforces the contract limits', () => {
    expect(validateSignUp({ ...ok, name: 'n'.repeat(201) }).name).toMatch(/at most 200/);
    expect(validateSignUp({ ...ok, email: 'nope' }).email).toBe('Enter a valid email address.');
    const long = 'x'.repeat(129);
    expect(validateSignUp({ ...ok, password: long }).password).toMatch(/at most 128/);
  });
});
