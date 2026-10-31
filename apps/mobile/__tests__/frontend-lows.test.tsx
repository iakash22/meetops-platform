import { AppState, Text } from 'react-native';
import { act, render } from '@testing-library/react-native';

import { AuthProvider } from '../src/auth/AuthProvider';
import { createDeviceIdProvider, DEVICE_ID_KEY } from '../src/auth/deviceId';
import type { SecureStoreLike } from '../src/auth/secureTokenStore';
import type { SessionManager } from '../src/auth/sessionManager';
import {
  createPushRegistrationService,
  createPushWipeHook,
  createDemoPushTokenProvider,
  type PushRegistrationService,
} from '../src/notifications/pushRegistration';

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }), { virtual: false });

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('#275 L-4 device id read error', () => {
  it('does not overwrite the stored id when the read fails, and recovers it later', async () => {
    const items = new Map([[DEVICE_ID_KEY, A]]);
    let fail = true;
    const store: SecureStoreLike = {
      getItemAsync: jest.fn(() =>
        fail
          ? Promise.reject(new Error('locked'))
          : Promise.resolve(items.get(DEVICE_ID_KEY) ?? null),
      ),
      setItemAsync: jest.fn((k: string, v: string) => {
        items.set(k, v);
        return Promise.resolve();
      }),
      deleteItemAsync: jest.fn(() => Promise.resolve()),
    };
    const ids = createDeviceIdProvider(store, () => B);
    expect(await ids.get()).toBe(B);
    expect(await ids.get()).toBe(B);
    expect(store.setItemAsync).not.toHaveBeenCalled();
    expect(items.get(DEVICE_ID_KEY)).toBe(A);
    fail = false;
    expect(await ids.get()).toBe(A);
    expect(store.setItemAsync).not.toHaveBeenCalled();
  });
});

describe('#262 Low push unregister on forced wipe', () => {
  it('unregisters every service without blocking, and swallows failures', async () => {
    const calls: string[] = [];
    let release!: () => void;
    const pending = new Promise<void>((r) => (release = r));
    const s = createPushRegistrationService(
      createDemoPushTokenProvider('granted'),
      {
        register: () => Promise.resolve({ id: 'd1', platform: 'ios', createdAt: 'x' }),
        unregister: (id) => {
          calls.push(id);
          return pending;
        },
      },
      'ios',
    );
    await s.enable();
    const bad: PushRegistrationService = {
      current: jest.fn(),
      enable: jest.fn(),
      disable: () => Promise.reject(new Error('ExponentPushToken[secret]')),
    };
    const map = new Map([
      ['u1', s],
      ['u2', bad],
    ]);
    const spy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const result = createPushWipeHook(map)();
    expect(result).toBeUndefined(); // synchronous: the wipe never waits on the network
    expect(map.size).toBe(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toEqual(['d1']);
    release();
    await pending;
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('#275 L-2 restore on foreground', () => {
  it('re-runs restore when the app becomes active while signed out', async () => {
    let handler: ((s: string) => void) | undefined;
    const remove = jest.fn();
    jest.spyOn(AppState, 'addEventListener').mockImplementation(((
      _: string,
      h: (s: string) => void,
    ) => {
      handler = h;
      return { remove };
    }) as never);
    let status = 'signedOut';
    const restore = jest.fn(() => Promise.resolve());
    const manager = {
      getState: () => ({ status }),
      restore,
    } as unknown as SessionManager;
    const { unmount } = render(
      <AuthProvider manager={manager}>
        <Text>x</Text>
      </AuthProvider>,
    );
    expect(restore).not.toHaveBeenCalled();
    await act(async () => handler?.('background'));
    expect(restore).not.toHaveBeenCalled();
    await act(async () => handler?.('active'));
    expect(restore).toHaveBeenCalledTimes(1);
    status = 'signedIn';
    await act(async () => handler?.('active'));
    expect(restore).toHaveBeenCalledTimes(1);
    unmount();
    expect(remove).toHaveBeenCalled();
  });
});
