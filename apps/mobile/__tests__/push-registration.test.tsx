import { View } from 'react-native';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { pushServiceFor, unregisterPushOnSignOut } from '../src/services';
import { PushNotificationsCard } from '../src/notifications/PushNotificationsCard';
import {
  createDemoPushTokenProvider,
  createHttpPushDeviceApi,
  createPushRegistrationService,
  type PushDeviceApi,
} from '../src/notifications/pushRegistration';

function api(): PushDeviceApi & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    register: (b) => {
      calls.push(`register:${b.provider}:${b.platform}`);
      return Promise.resolve({ id: 'd1', platform: b.platform, createdAt: '2026-01-01T00:00:00Z' });
    },
    unregister: (id) => {
      calls.push(`unregister:${id}`);
      return Promise.resolve();
    },
  };
}

describe('push registration', () => {
  it('asks permission only on tap, registers, then unregisters', async () => {
    const provider = createDemoPushTokenProvider('granted');
    const request = jest.spyOn(provider, 'requestPermission');
    const a = api();
    render(<PushNotificationsCard service={createPushRegistrationService(provider, a, 'ios')} />);
    await screen.findByTestId('push-toggle');
    expect(request).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('push-toggle'));
    expect(await screen.findByText(/on for this device/)).toBeTruthy();
    expect(a.calls).toEqual(['register:expo:ios']);
    fireEvent.press(screen.getByTestId('push-toggle'));
    await waitFor(() => expect(a.calls).toEqual(['register:expo:ios', 'unregister:d1']));
  });

  it('shows settings guidance and does not register when denied', async () => {
    const a = api();
    render(
      <PushNotificationsCard
        service={createPushRegistrationService(createDemoPushTokenProvider('denied'), a, 'android')}
      />,
    );
    fireEvent.press(await screen.findByTestId('push-toggle'));
    expect(await screen.findByText(/blocked/)).toBeTruthy();
    expect(screen.queryByTestId('push-toggle')).toBeNull();
    expect(a.calls).toEqual([]);
  });

  it('reports a failed registration without leaking details', async () => {
    const a = api();
    a.register = () => Promise.reject(new Error('ExponentPushToken[secret] 500'));
    const s = createPushRegistrationService(createDemoPushTokenProvider('granted'), a, 'ios');
    const r = await s.enable();
    expect(r).toEqual({ status: 'error', message: 'Could not turn on notifications. Try again.' });
  });
});

describe('createHttpPushDeviceApi', () => {
  const device = { id: 'd1', platform: 'ios', createdAt: '2026-10-27T00:00:00.000Z' };

  it('POSTs /me/push-devices (201) and DELETEs /me/push-devices/:id (204)', async () => {
    const request = jest.fn().mockResolvedValueOnce(device).mockResolvedValueOnce(undefined);
    const http = createHttpPushDeviceApi(request);
    const body = {
      provider: 'expo' as const,
      token: 'ExponentPushToken[abcdefghijkl]',
      platform: 'ios' as const,
    };
    await expect(http.register(body)).resolves.toEqual(device);
    await http.unregister('a/b');
    expect(request.mock.calls).toEqual([
      ['POST', '/me/push-devices', body, 201],
      ['DELETE', '/me/push-devices/a%2Fb', undefined, 204],
    ]);
  });

  it('does not report on when the server response is not a PushDevice', async () => {
    const http = createHttpPushDeviceApi(jest.fn().mockResolvedValue({}));
    const s = createPushRegistrationService(createDemoPushTokenProvider('granted'), http, 'ios');
    expect((await s.enable()).status).toBe('error');
  });
});

describe('per-user push state and sign-out', () => {
  it('says push is unavailable when there is no service (live build without a native provider)', async () => {
    render(<PushNotificationsCard service={null} />);
    expect(await screen.findByText(/aren't available in this build/)).toBeTruthy();
    expect(screen.queryByTestId('push-toggle')).toBeNull();
  });

  it('resets state for a different user (keyed card, separate service)', async () => {
    const a = api();
    const s1 = createPushRegistrationService(createDemoPushTokenProvider('granted'), a, 'ios');
    const s2 = createPushRegistrationService(createDemoPushTokenProvider('granted'), api(), 'ios');
    const Account = ({ userId }: { userId: string }) => (
      <View>
        <PushNotificationsCard key={userId} service={userId === 'u1' ? s1 : s2} />
      </View>
    );
    const view = render(<Account userId="u1" />);
    fireEvent.press(await screen.findByTestId('push-toggle'));
    expect(await screen.findByText(/on for this device/)).toBeTruthy();
    view.rerender(<Account userId="u2" />);
    expect(await screen.findByText(/Get notified/)).toBeTruthy();
  });

  it('unregisters the device on sign-out and forgets the user service', async () => {
    const s = pushServiceFor('user-1');
    expect(s).not.toBeNull();
    await s!.enable();
    expect((await s!.current()).status).toBe('on');
    const disable = jest.spyOn(s!, 'disable');
    await unregisterPushOnSignOut('user-1');
    expect(disable).toHaveBeenCalled();
    expect(pushServiceFor('user-1')).not.toBe(s);
  });
});
