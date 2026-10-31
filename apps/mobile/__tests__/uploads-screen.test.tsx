import '@testing-library/react-native/extend-expect';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { Animated } from 'react-native';

import { AuthProvider } from '../src/auth/AuthProvider';
import { RepositoriesProvider } from '../src/data/RepositoriesProvider';
import type { UploadQueueStatus } from '../src/data/uploadQueue';
import { AccountScreen } from '../src/screens/AccountScreen';
import { UploadsScreen } from '../src/screens/UploadsScreen';
import { account, makeManager, makeRepositories } from './support/appRoutes';

async function renderUploads(status: () => Promise<UploadQueueStatus>) {
  render(
    <RepositoriesProvider value={makeRepositories({ uploadQueue: { status } })}>
      <UploadsScreen />
    </RepositoriesProvider>,
  );
  await act(async () => {});
}

beforeEach(() => {
  jest
    .spyOn(Animated, 'loop')
    .mockReturnValue({ start: jest.fn(), stop: jest.fn(), reset: jest.fn() });
});
afterEach(() => jest.restoreAllMocks());

describe('UploadsScreen', () => {
  it('shows a busy skeleton while loading', () => {
    render(
      <RepositoriesProvider
        value={makeRepositories({ uploadQueue: { status: () => new Promise(() => {}) } })}
      >
        <UploadsScreen />
      </RepositoriesProvider>,
    );
    expect(screen.getByTestId('uploads-loading')).toBeBusy();
  });

  it('empty state when nothing is queued', async () => {
    await renderUploads(() => Promise.resolve({ pending: 0, offline: false }));
    expect(screen.getByTestId('uploads-empty')).toHaveTextContent(/All recordings uploaded/);
    expect(screen.queryByTestId('uploads-offline')).toBeNull();
  });

  it('offline, pending, failed and expiring counts', async () => {
    await renderUploads(() =>
      Promise.resolve({ pending: 2, offline: true, failed: 1, expiringSoon: 1 }),
    );
    expect(screen.getByTestId('uploads-offline')).toHaveTextContent(/offline/);
    expect(screen.getByTestId('uploads-pending')).toHaveTextContent(/2 recordings waiting/);
    expect(screen.getByTestId('uploads-pending')).toHaveTextContent(/resume when you reconnect/);
    expect(screen.getByTestId('uploads-failed')).toHaveTextContent(/1 recording couldn't upload/);
    expect(screen.getByTestId('uploads-expiring')).toHaveTextContent(/about to expire/);
  });

  it('error state retries', async () => {
    const status = jest
      .fn<Promise<UploadQueueStatus>, []>()
      .mockRejectedValueOnce(new Error('disk'))
      .mockResolvedValue({ pending: 1, offline: false });
    await renderUploads(status);
    expect(screen.getByTestId('uploads-error')).toBeTruthy();
    fireEvent.press(screen.getByTestId('uploads-error-retry'));
    await act(async () => {});
    expect(status).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('uploads-pending')).toHaveTextContent(/1 recording waiting/);
  });
});

describe('AccountScreen recordings section', () => {
  it('links to the upload queue and explains consent-first recording', async () => {
    const { manager } = makeManager();
    await manager.signIn(account);
    render(
      <AuthProvider manager={manager}>
        <RepositoriesProvider value={makeRepositories()}>
          <AccountScreen />
        </RepositoriesProvider>
      </AuthProvider>,
    );
    await act(async () => {});
    expect(screen.getByTestId('account-uploads')).toBeTruthy();
    expect(screen.getByTestId('account-recording-privacy')).toHaveTextContent(
      /only after you opt in/,
    );
  });
});
