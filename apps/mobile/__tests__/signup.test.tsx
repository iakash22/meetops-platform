import '@testing-library/react-native/extend-expect';
import { fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';

import { ApiError, createApiClient } from '../src/api/client';
import { createDemoSignupApi, type SignupApi } from '../src/auth/SignupApiProvider';
import { validateSignup } from '../src/auth/signupValidation';
import { isEnumerationSafeSuccess, signupErrorMessage } from '../src/screens/SignupScreen';
import { makeManager, makeRepositories, routes } from './support/appRoutes';

/** Real `createApiClient().signup` over a fake fetch, so the screen exercises the actual API call. */
function apiReturning(status: number, body?: unknown) {
  const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit | undefined]>(() =>
    Promise.resolve(new Response(body === undefined ? null : JSON.stringify(body), { status })),
  );
  const api = createApiClient({
    baseUrl: 'https://api.example.test',
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { api, fetchImpl };
}

function renderSignup(api: SignupApi = createDemoSignupApi()) {
  const { manager } = makeManager();
  renderRouter(routes(manager, makeRepositories(), api), { initialUrl: '/signup' });
  return manager;
}

async function fillValid(email = 'grace@example.com') {
  fireEvent.changeText(await screen.findByTestId('signup-name'), 'Grace Hopper');
  fireEvent.changeText(screen.getByTestId('signup-email'), email);
  fireEvent.changeText(screen.getByTestId('signup-password'), 'Correct-horse-1');
}

describe('validateSignup', () => {
  const ok = {
    name: ' Ada ',
    email: ' ada@example.com ',
    password: 'Correct-1!',
  };

  it('trims and returns a contracts SignupRequest', () => {
    expect(validateSignup(ok)).toEqual({
      ok: true,
      errors: {},
      request: { name: 'Ada', email: 'ada@example.com', password: 'Correct-1!' },
    });
  });

  it('enforces SignupRequest limits (no confirm-password field)', () => {
    const { errors } = validateSignup({
      name: 'n'.repeat(201),
      email: 'nope',
      password: 'short',
    });
    expect(errors).toEqual({
      name: 'Use at most 200 characters.',
      email: 'Enter a valid email address.',
      password: 'Use 8 or more characters with a letter, a number, and a symbol.',
    });
    const long = 'x'.repeat(129);
    expect(validateSignup({ ...ok, password: long }).errors.password).toBe('Password is too long.');
  });
});

describe('signup error mapping', () => {
  it('treats EMAIL_TAKEN as success (enumeration-safe) and everything else as a toast', () => {
    const taken = new ApiError(409, 'CONFLICT', 'x', undefined, 'EMAIL_TAKEN');
    expect(isEnumerationSafeSuccess(taken)).toBe(true);
    expect(isEnumerationSafeSuccess(new ApiError(429, 'RATE_LIMITED', 'x'))).toBe(false);
    expect(signupErrorMessage(new ApiError(429, 'RATE_LIMITED', 'secret server text'))).toBe(
      'Too many attempts. Try again later.',
    );
    expect(signupErrorMessage(new Error('boom'))).toBe(
      'Something went wrong. Check your connection and try again.',
    );
  });
});

describe('signup screen', () => {
  it('is linked from the login screen and links back to it', async () => {
    const { manager } = makeManager();
    renderRouter(routes(manager), { initialUrl: '/login' });
    fireEvent.press(await screen.findByTestId('login-to-signup'));
    await waitFor(() => expect(screen).toHavePathname('/signup'));
    expect(screen.getByText('Create your account')).toBeTruthy();
    fireEvent.press(screen.getByTestId('signup-to-login'));
    await waitFor(() => expect(screen).toHavePathname('/login'));
  });

  it('shows inline field errors and does not call the API for an empty form', async () => {
    const api = createDemoSignupApi();
    const spy = jest.spyOn(api, 'signup');
    renderSignup(api);
    fireEvent.press(await screen.findByTestId('signup-submit'));
    expect(await screen.findByTestId('signup-name-error')).toHaveTextContent('Enter your name.');
    expect(screen.getByTestId('signup-email-error')).toHaveTextContent('Enter your email address.');
    expect(screen.getByTestId('signup-password-error')).toHaveTextContent('Create a password.');
    expect(screen.queryByTestId('signup-confirm')).toBeNull();
    expect(screen.queryByTestId('signup-toast')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('clears a field error once that field is edited', async () => {
    renderSignup();
    fireEvent.press(await screen.findByTestId('signup-submit'));
    fireEvent.changeText(screen.getByTestId('signup-name'), 'G');
    expect(screen.queryByTestId('signup-name-error')).toBeNull();
    expect(screen.getByTestId('signup-email-error')).toBeTruthy();
  });

  it('shows the password policy hint and toggles password visibility', async () => {
    renderSignup();
    const hint = await screen.findByTestId('signup-password-hint');
    expect(hint).toHaveTextContent('8+ with a letter, number, and symbol');
    expect(hint).not.toHaveTextContent('✓');
    fireEvent.changeText(screen.getByTestId('signup-password'), 'Abcdef1!');
    expect(screen.getByTestId('signup-password-hint')).toHaveTextContent(
      '✓ 8+ with a letter, number, and symbol',
    );
    expect(screen.getByTestId('signup-password').props.secureTextEntry).toBe(true);
    fireEvent.press(screen.getByTestId('signup-toggle-password'));
    expect(screen.getByTestId('signup-password').props.secureTextEntry).toBe(false);
    expect(screen.getByText('Hide password')).toBeTruthy();
  });

  it('posts to /auth/signup and shows the check-your-email state without signing in', async () => {
    const { api, fetchImpl } = apiReturning(202, { message: 'ok' });
    const manager = renderSignup(api);
    await fillValid(' grace@example.com ');
    fireEvent.press(screen.getByTestId('signup-submit'));
    expect(await screen.findByTestId('signup-check-email')).toHaveTextContent(/grace@example\.com/);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe('https://api.example.test/auth/signup');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      name: 'Grace Hopper',
      email: 'grace@example.com',
      password: 'Correct-horse-1',
    });
    expect(manager.getState().status).toBe('signedOut');
    fireEvent.press(screen.getByTestId('signup-back-to-login'));
    await waitFor(() => expect(screen).toHavePathname('/login'));
  });

  it('rates password strength with an accessible label', async () => {
    renderSignup();
    expect(await screen.findByLabelText('Password strength: Too short')).toBeTruthy();
    fireEvent.changeText(screen.getByTestId('signup-password'), 'aaaaaaaaaaaa');
    expect(screen.getByLabelText('Password strength: Weak')).toBeTruthy();
    fireEvent.changeText(screen.getByTestId('signup-password'), 'Correct-Horse-Battery-9');
    expect(screen.getByLabelText('Password strength: Strong')).toBeTruthy();
  });

  it('ends on check-your-email for EMAIL_TAKEN, never an already-taken message', async () => {
    const { api } = apiReturning(409, {
      error: { code: 'CONFLICT', message: 'taken', reason: 'EMAIL_TAKEN' },
    });
    renderSignup(api);
    await fillValid();
    fireEvent.press(screen.getByTestId('signup-submit'));
    expect(await screen.findByTestId('signup-check-email')).toBeTruthy();
    expect(screen.queryByText(/already exists/)).toBeNull();
    expect(screen.queryByTestId('signup-email-error')).toBeNull();
    expect(screen.queryByTestId('signup-toast')).toBeNull();
  });

  it('shows non-field errors in a dismissible toast', async () => {
    const { api } = apiReturning(503);
    renderSignup(api);
    await fillValid();
    fireEvent.press(screen.getByTestId('signup-submit'));
    expect(await screen.findByTestId('signup-toast')).toHaveTextContent(
      /^Something went wrong\. Check your connection and try again\./,
    );
    expect(screen.queryByTestId('signup-check-email')).toBeNull();
    fireEvent.press(screen.getByTestId('signup-toast-dismiss'));
    expect(screen.queryByTestId('signup-toast')).toBeNull();
  });
});
