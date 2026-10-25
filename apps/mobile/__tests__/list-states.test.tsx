import '@testing-library/react-native/extend-expect';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Animated, StyleSheet } from 'react-native';
import type { ReactElement } from 'react';

import { AuthProvider } from '../src/auth/AuthProvider';
import { RepositoriesProvider, type Repositories } from '../src/data/RepositoriesProvider';
import { MeetingsScreen } from '../src/screens/MeetingsScreen';
import { TasksScreen } from '../src/screens/TasksScreen';
import { colors } from '../src/theme/colors';
import { account, makeManager, makeRepositories } from './support/appRoutes';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function renderWith(ui: ReactElement, repos: Repositories) {
  const { manager } = makeManager();
  await manager.signIn(account);
  render(
    <AuthProvider manager={manager}>
      <RepositoriesProvider value={repos}>{ui}</RepositoriesProvider>
    </AuthProvider>,
  );
  await act(async () => {});
}

beforeEach(() => {
  jest
    .spyOn(Animated, 'loop')
    .mockReturnValue({ start: jest.fn(), stop: jest.fn(), reset: jest.fn() });
});
afterEach(() => jest.restoreAllMocks());

describe('list loading, empty and error states', () => {
  it('tasks: skeleton while loading, then the list', async () => {
    const d = deferred<never[]>();
    const list = jest.fn(() => d.promise);
    await renderWith(<TasksScreen />, makeRepositories({ tasks: { list } }));
    const skeleton = screen.getByTestId('tasks-skeleton');
    expect(skeleton).toHaveProp('accessibilityLabel', 'Loading tasks');
    expect(skeleton).toBeBusy();
    expect(list).toHaveBeenCalledWith(expect.any(String));
    await act(async () => d.resolve([]));
    expect(screen.queryByTestId('tasks-skeleton')).toBeNull();
    expect(screen.getByTestId('tasks-empty')).toHaveTextContent(/No tasks yet/);
  });

  it('tasks: placeholder rows are scoped to the active organization', async () => {
    const repos = makeRepositories();
    const spy = jest.spyOn(repos.tasks, 'list');
    await renderWith(<TasksScreen />, repos);
    expect(await screen.findAllByTestId('task-row')).toHaveLength(3);
    const orgId = spy.mock.calls[0]?.[0];
    const rows = await spy.mock.results[0]?.value;
    expect((rows as { organizationId: string }[]).every((t) => t.organizationId === orgId)).toBe(
      true,
    );
    expect(screen.getAllByTestId('task-row')[0]).toHaveProp(
      'accessibilityLabel',
      'Send recap to the customer, To do, High priority',
    );
  });

  it('meetings: empty state', async () => {
    await renderWith(
      <MeetingsScreen />,
      makeRepositories({ meetings: { list: () => Promise.resolve([]) } }),
    );
    expect(screen.getByTestId('meetings-empty')).toHaveTextContent(/No meetings yet/);
  });

  it('meetings: error uses the destructive colour (not rose) and retries', async () => {
    const list = jest.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([]);
    await renderWith(<MeetingsScreen />, makeRepositories({ meetings: { list } }));
    const message = screen.getByText("Couldn't load meetings.");
    expect(message).toHaveProp('accessibilityRole', 'alert');
    const color = StyleSheet.flatten(message.props.style).color;
    expect(color).toBe(colors.destructive);
    expect(color).not.toBe(colors.accent);
    fireEvent.press(screen.getByTestId('meetings-error-retry'));
    await act(async () => {});
    expect(list).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('meetings-empty')).toBeTruthy();
  });
});
