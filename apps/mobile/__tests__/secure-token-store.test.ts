import {
  createSecureTokenStore,
  TOKEN_KEY,
  type SecureStoreLike,
} from '../src/auth/secureTokenStore';
import type { MobileAuthTokens } from '../src/auth/types';

const tokens: MobileAuthTokens = {
  tokenType: 'Bearer',
  accessToken: 'a',
  expiresAt: '2030-01-01T00:00:00.000Z',
  refreshToken: 'r',
  refreshExpiresAt: '2030-02-01T00:00:00.000Z',
  organizationId: 'org-1',
};

function fakeStore() {
  const items = new Map<string, string>();
  const store: SecureStoreLike = {
    getItemAsync: jest.fn((k: string) => Promise.resolve(items.get(k) ?? null)),
    setItemAsync: jest.fn((k: string, v: string) => {
      items.set(k, v);
      return Promise.resolve();
    }),
    deleteItemAsync: jest.fn((k: string) => {
      items.delete(k);
      return Promise.resolve();
    }),
  };
  return { items, store };
}

describe('createSecureTokenStore', () => {
  it('round-trips tokens with device-only keychain access', async () => {
    const { store } = fakeStore();
    const s = createSecureTokenStore(store);
    await s.save(tokens);
    await expect(s.load()).resolves.toEqual(tokens);
    expect(store.setItemAsync).toHaveBeenCalledWith(
      TOKEN_KEY,
      expect.any(String),
      expect.objectContaining({ keychainAccessible: expect.anything() }),
    );
  });

  it('returns null when nothing is stored', async () => {
    await expect(createSecureTokenStore(fakeStore().store).load()).resolves.toBeNull();
  });

  it.each(['not json', '{"tokenType":"Bearer"}', '[]'])('drops a corrupt item %p', async (raw) => {
    const { items, store } = fakeStore();
    items.set(TOKEN_KEY, raw);
    await expect(createSecureTokenStore(store).load()).resolves.toBeNull();
    expect(items.has(TOKEN_KEY)).toBe(false);
  });

  it('clears even when delete fails', async () => {
    const { store } = fakeStore();
    store.deleteItemAsync = () => Promise.reject(new Error('missing'));
    await expect(createSecureTokenStore(store).clear()).resolves.toBeUndefined();
  });
});
