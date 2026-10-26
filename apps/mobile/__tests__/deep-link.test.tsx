import '@testing-library/react-native/extend-expect';
import { fireEvent, renderRouter, screen, waitFor } from 'expo-router/testing-library';

import { safeReturnPath } from '../src/auth/deepLink';
import { account, makeManager, routes } from './support/appRoutes';

describe('safeReturnPath', () => {
  it.each(['/', '/tasks', '/record', '/account', '/organizations', '/tasks/', '/tasks?x=1'])(
    'accepts our own screen %s',
    (p) => expect(safeReturnPath(p)).not.toBeNull(),
  );

  it.each([
    undefined,
    '',
    'tasks',
    '//evil.example/tasks',
    'https://evil.example',
    'javascript:alert(1)',
    '/\\evil.example',
    '%2F%2Fevil.example',
    '/login',
    '/signup',
    '/meetings/../../etc',
    '/unknown',
    '%E0%A4%A',
    `/${'a'.repeat(80)}`,
    42,
  ])('rejects %p', (p) => expect(safeReturnPath(p)).toBeNull());

  it('takes the first value of a repeated param', () => {
    expect(safeReturnPath(['/tasks', '//evil'])).toBe('/tasks');
  });
});

describe('deep-link guards', () => {
  const signIn = async () => {
    fireEvent.changeText(await screen.findByTestId('login-email'), account.email);
    fireEvent.changeText(screen.getByTestId('login-password'), account.password);
    fireEvent.press(screen.getByTestId('login-submit'));
  };

  it('follows a safe next param after sign-in', async () => {
    const { manager } = makeManager();
    renderRouter(routes(manager), { initialUrl: '/login?next=%2Ftasks' });
    await signIn();
    await waitFor(() => expect(screen).toHavePathname('/tasks'));
  });

  it('ignores an unsafe next param and goes home', async () => {
    const { manager } = makeManager();
    renderRouter(routes(manager), { initialUrl: '/login?next=%2F%2Fevil.example' });
    await signIn();
    await waitFor(() => expect(screen).toHavePathname('/'));
  });

  it('shows a not-found screen for unknown links', async () => {
    const { manager } = makeManager();
    renderRouter(routes(manager), { initialUrl: '/definitely-not-a-screen' });
    expect(await screen.findByTestId('not-found')).toBeTruthy();
  });

  it('follows a safe next param when already signed in', async () => {
    const { manager } = makeManager();
    await manager.signIn(account);
    renderRouter(routes(manager), { initialUrl: '/login?next=%2Ftasks' });
    await waitFor(() => expect(screen).toHavePathname('/tasks'));
  });
});
