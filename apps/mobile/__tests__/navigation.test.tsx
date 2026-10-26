import '@testing-library/react-native/extend-expect';
import { act, fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';

import { guardRedirect } from '../src/auth/guards';
import { account, makeManager, routes } from './support/appRoutes';

describe('guardRedirect', () => {
  it('maps auth state and route group to a redirect', () => {
    expect(guardRedirect('loading', 'app')).toBeNull();
    expect(guardRedirect('loading', 'auth')).toBeNull();
    expect(guardRedirect('signedOut', 'app')).toBe('/login');
    expect(guardRedirect('signedOut', 'auth')).toBeNull();
    expect(guardRedirect('signedIn', 'auth')).toBe('/');
    expect(guardRedirect('signedIn', 'app')).toBeNull();
  });
});

describe('navigation guards and screens', () => {
  it('redirects a signed-out user from / to /login', async () => {
    const { manager } = makeManager();
    renderRouter(routes(manager), { initialUrl: '/' });
    await waitFor(() => expect(screen).toHavePathname('/login'));
    expect(await screen.findByText('Sign in to MeetOps')).toBeTruthy();
  });

  it.each(['/record', '/tasks', '/account', '/organizations'])(
    'guards the %s tab route for signed-out users',
    async (url) => {
      const { manager } = makeManager();
      renderRouter(routes(manager), { initialUrl: url });
      await waitFor(() => expect(screen).toHavePathname('/login'));
    },
  );

  it('shows field errors and does not call the client for an empty form', async () => {
    const { manager, client } = makeManager();
    const spy = jest.spyOn(client, 'login');
    renderRouter(routes(manager), { initialUrl: '/login' });
    fireEvent.press(await screen.findByTestId('login-submit'));
    expect(await screen.findByTestId('login-email-error')).toHaveTextContent(
      'Enter your email address.',
    );
    expect(screen.getByTestId('login-password-error')).toHaveTextContent('Enter your password.');
    expect(spy).not.toHaveBeenCalled();
  });

  it('shows a generic error and clears the password on bad credentials', async () => {
    const { manager } = makeManager();
    renderRouter(routes(manager), { initialUrl: '/login' });
    fireEvent.changeText(await screen.findByTestId('login-email'), account.email);
    fireEvent.changeText(screen.getByTestId('login-password'), 'wrong password');
    fireEvent.press(screen.getByTestId('login-submit'));
    expect(await screen.findByTestId('login-error')).toHaveTextContent(
      /Invalid email or password\./,
    );
    expect(screen.getByTestId('login-password').props.value).toBe('');
    expect(screen).toHavePathname('/login');
  });

  it('signs in and lands on the meetings tab for the active org', async () => {
    const { manager } = makeManager();
    renderRouter(routes(manager), { initialUrl: '/login' });
    fireEvent.changeText(await screen.findByTestId('login-email'), account.email);
    fireEvent.changeText(screen.getByTestId('login-password'), account.password);
    fireEvent.press(screen.getByTestId('login-submit'));
    await waitFor(() => expect(screen).toHavePathname('/'));
    expect(await screen.findByTestId('active-org')).toHaveTextContent('Demo Organization');
    expect(await screen.findAllByTestId('meeting-row')).toHaveLength(4);
    // Rose accent marks only the live meeting.
    expect(screen.getAllByTestId('live-dot', { includeHiddenElements: true })).toHaveLength(1);
    expect(screen.getByText('Live')).toBeTruthy();
  });

  it('keeps a signed-in user out of /login', async () => {
    const { manager } = makeManager();
    await manager.signIn(account);
    renderRouter(routes(manager), { initialUrl: '/login' });
    await waitFor(() => expect(screen).toHavePathname('/'));
  });

  it('switches organization from the switcher and runs the wipe hook', async () => {
    const { manager } = makeManager();
    await manager.signIn(account);
    const wipe = jest.fn();
    manager.registerWipeHook(wipe);
    renderRouter(routes(manager), { initialUrl: '/' });
    fireEvent.press(await screen.findByTestId('switch-org-link'));
    await waitFor(() => expect(screen).toHavePathname('/organizations'));
    fireEvent.press(await screen.findByTestId('org-second-org'));
    await waitFor(() => expect(screen).toHavePathname('/'));
    expect(await screen.findByTestId('active-org')).toHaveTextContent('Second Org');
    expect(wipe).toHaveBeenCalledTimes(1);
  });

  it('signs out, wipes stored tokens and returns to /login', async () => {
    const { manager, store } = makeManager();
    await manager.signIn(account);
    expect(await store.load()).not.toBeNull();
    renderRouter(routes(manager), { initialUrl: '/account' });
    fireEvent.press(await screen.findByTestId('sign-out'));
    await waitFor(() => expect(screen).toHavePathname('/login'));
    expect(await store.load()).toBeNull();
  });

  it('sends the user to /login when the session ends elsewhere', async () => {
    const { manager } = makeManager();
    await manager.signIn(account);
    renderRouter(routes(manager), { initialUrl: '/' });
    await screen.findByTestId('active-org');
    await act(() => manager.signOut());
    await waitFor(() => expect(screen).toHavePathname('/login'));
  });
});
