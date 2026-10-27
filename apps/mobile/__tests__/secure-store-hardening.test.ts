import { createDeviceIdProvider, DEVICE_ID_KEY } from '../src/auth/deviceId';
import {
  createSecureTokenStore,
  KeychainUnavailableError,
  TOKEN_KEY,
  type SecureStoreLike,
} from '../src/auth/secureTokenStore';
import { createSessionManager } from '../src/auth/sessionManager';
import type { AuthClient, MobileAuthTokens } from '../src/auth/types';

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn() }), { virtual: false });

const pair = (n: number, expired = false): MobileAuthTokens => ({
  tokenType: 'Bearer',
  accessToken: `access-${n}`,
  expiresAt: expired ? '2000-01-01T00:00:00.000Z' : '2030-01-01T00:00:00.000Z',
  refreshToken: `refresh-${n}`,
  refreshExpiresAt: '2030-02-01T00:00:00.000Z',
  organizationId: 'org-1',
});

function keychain() {
  const items = new Map<string, string>();
  let locked = false;
  const guard = () => (locked ? Promise.reject(new Error('errSecInteractionNotAllowed')) : null);
  const store: SecureStoreLike = {
    getItemAsync: jest.fn((k: string) => guard() ?? Promise.resolve(items.get(k) ?? null)),
    setItemAsync: jest.fn((k: string, v: string) => {
      const g = guard();
      if (g) return g;
      items.set(k, v);
      return Promise.resolve();
    }),
    deleteItemAsync: jest.fn((k: string) => {
      items.delete(k);
      return Promise.resolve();
    }),
  };
  return { items, store, lock: (v: boolean) => (locked = v) };
}

describe('secure token store hardening', () => {
  it('uses AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY', async () => {
    const k = keychain();
    await createSecureTokenStore(k.store).save(pair(1));
    const opts = (k.store.setItemAsync as jest.Mock).mock.calls[0]?.[2] as {
      keychainAccessible?: unknown;
    };
    const SecureStore = jest.requireActual<typeof import('expo-secure-store')>('expo-secure-store');
    expect(opts.keychainAccessible).toBe(SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY);
  });

  it('never persists the access token', async () => {
    const k = keychain();
    await createSecureTokenStore(k.store).save(pair(1));
    const raw = k.items.get(TOKEN_KEY) ?? '';
    expect(raw).not.toContain('access-1');
    expect(JSON.parse(raw)).not.toHaveProperty('accessToken');
    const cold = await createSecureTokenStore(k.store).load();
    expect(cold?.accessToken).toBe('');
    expect(cold?.refreshToken).toBe('refresh-1');
    expect(Date.parse(cold!.expiresAt)).toBe(0);
  });

  it('M-1: keeps the rotated pair in memory when the keychain is locked, then retries the write', async () => {
    const k = keychain();
    const s = createSecureTokenStore(k.store);
    await s.save(pair(1));
    k.lock(true);
    await expect(s.save(pair(2))).resolves.toBeUndefined();
    await expect(s.load()).resolves.toEqual(pair(2));
    k.lock(false);
    await s.load();
    expect(JSON.parse(k.items.get(TOKEN_KEY)!).refreshToken).toBe('refresh-2');
  });

  it('M-1: a refresh finishing while locked does not lose the new pair or replay the old token', async () => {
    const k = keychain();
    const store = createSecureTokenStore(k.store);
    await store.save(pair(1, true));
    const refresh = jest
      .fn<Promise<MobileAuthTokens>, [string]>()
      .mockResolvedValueOnce(pair(2, true))
      .mockResolvedValueOnce(pair(3));
    const client = { refresh } as unknown as AuthClient;
    const m = createSessionManager({ client, store });
    k.lock(true);
    await expect(m.getAccessToken()).resolves.toBe('access-2');
    await expect(m.getAccessToken()).resolves.toBe('access-3');
    expect(refresh.mock.calls.map((c) => c[0])).toEqual(['refresh-1', 'refresh-2']);
  });

  it('cold start with a locked keychain: signed out, item kept, recovers on next restore', async () => {
    const k = keychain();
    await createSecureTokenStore(k.store).save(pair(1));
    const store = createSecureTokenStore(k.store);
    k.lock(true);
    await expect(store.load()).rejects.toBeInstanceOf(KeychainUnavailableError);
    const refresh = jest.fn();
    const client = { refresh, getSession: jest.fn() } as unknown as AuthClient;
    const m = createSessionManager({ client, store });
    await m.restore();
    expect(m.getState().status).toBe('signedOut');
    expect(k.items.has(TOKEN_KEY)).toBe(true);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('device id', () => {
  const uuid = (n: number) => `0f8e2c1a-3b4d-4e5f-9a6b-7c8d9e0f1a2${n}`;

  it('generates once, stores securely, and is stable across instances', async () => {
    const k = keychain();
    const gen = jest.fn(() => uuid(1));
    const a = createDeviceIdProvider(k.store, gen);
    const [x, y] = await Promise.all([a.get(), a.get()]);
    expect(x).toBe(uuid(1));
    expect(y).toBe(x);
    expect(k.items.get(DEVICE_ID_KEY)).toBe(uuid(1));
    await expect(createDeviceIdProvider(k.store, () => uuid(2)).get()).resolves.toBe(uuid(1));
    expect(gen).toHaveBeenCalledTimes(1);
  });

  it('replaces a malformed stored id and rejects a bad generator', async () => {
    const k = keychain();
    k.items.set(DEVICE_ID_KEY, 'not-a-uuid');
    await expect(createDeviceIdProvider(k.store, () => uuid(3)).get()).resolves.toBe(uuid(3));
    await expect(createDeviceIdProvider(keychain().store, () => 'x').get()).rejects.toThrow();
  });

  it('survives token clear (sign-out)', async () => {
    const k = keychain();
    await createDeviceIdProvider(k.store, () => uuid(4)).get();
    await createSecureTokenStore(k.store).clear();
    expect(k.items.get(DEVICE_ID_KEY)).toBe(uuid(4));
  });
});
