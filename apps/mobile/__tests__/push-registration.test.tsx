import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';

import { PushNotificationsCard } from '../src/notifications/PushNotificationsCard';
import {
  createDemoPushTokenProvider,
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
