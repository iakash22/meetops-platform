import { createMockAuthClient, demoAccount } from '../src/auth/mockAuthClient';
import { createSessionManager } from '../src/auth/sessionManager';
import { createInMemoryTokenStore } from '../src/auth/tokenStore';
import type { AuthClient } from '../src/auth/types';

const account = demoAccount('ada@example.com', 'correct horse battery');

function setup(opts: { accessTtlSeconds?: number } = {}) {
  let t = Date.parse('2026-10-25T00:00:00Z');
  const now = () => t;
  const client = createMockAuthClient({ accounts: [account], now, ...opts });
  const store = createInMemoryTokenStore();
  const manager = createSessionManager({ client, store, now });
  return { client, store, manager, advance: (ms: number) => (t += ms) };
}

describe('createSessionManager', () => {
  it('starts loading and restores to signedOut without tokens', async () => {
    const { manager } = setup();
    expect(manager.getState().status).toBe('loading');
    await manager.restore();
    expect(manager.getState().status).toBe('signedOut');
  });

  it('signs in, persists tokens and exposes the organizationId identity', async () => {
    const { manager, store } = setup();
    const listener = jest.fn();
    manager.subscribe(listener);
    await manager.signIn(account);
    const state = manager.getState();
    expect(state.status).toBe('signedIn');
    if (state.status !== 'signedIn') throw new Error('unreachable');
    expect(state.identity).toEqual({
      userId: account.user.id,
      organizationId: account.organizations[0]?.id,
    });
    expect(await store.load()).not.toBeNull();
    expect(listener).toHaveBeenCalled();
  });

  it('stays signedOut and stores nothing when login fails', async () => {
    const { manager, store } = setup();
    await manager.restore();
    await expect(manager.signIn({ email: account.email, password: 'bad' })).rejects.toMatchObject({
      code: 'AUTH_FAILED',
    });
    expect(manager.getState().status).toBe('signedOut');
    expect(await store.load()).toBeNull();
  });

  it('restores a stored session and refreshes an expired access token', async () => {
    const { client, store, advance } = setup({ accessTtlSeconds: 60 });
    const first = createSessionManager({
      client,
      store,
      now: () => Date.parse('2026-10-25T00:00:00Z'),
    });
    await first.signIn(account);
    const before = await store.load();
    advance(120_000);
    const relaunch = createSessionManager({
      client,
      store,
      now: () => Date.parse('2026-10-25T00:02:00Z'),
    });
    await relaunch.restore();
    expect(relaunch.getState().status).toBe('signedIn');
    expect((await store.load())?.refreshToken).not.toBe(before?.refreshToken);
  });

  it('wipes tokens on restore when the family was revoked', async () => {
    const { client, store, manager } = setup();
    await manager.signIn(account);
    const tokens = await store.load();
    if (tokens) await client.logout(tokens.refreshToken);
    await manager.restore();
    expect(manager.getState().status).toBe('signedOut');
    expect(await store.load()).toBeNull();
  });

  it('keeps tokens when restore fails for a non-auth reason (offline)', async () => {
    const { client, store, manager } = setup();
    await manager.signIn(account);
    const offline: AuthClient = {
      ...client,
      getSession: () => Promise.reject(new Error('Network request failed')),
    };
    const relaunch = createSessionManager({ client: offline, store });
    await relaunch.restore();
    expect(relaunch.getState().status).toBe('signedOut');
    expect(await store.load()).not.toBeNull();
  });

  it('signOut revokes server-side, clears storage and runs wipe hooks even if one throws', async () => {
    const { client, store, manager } = setup();
    await manager.signIn(account);
    const tokens = await store.load();
    const hookA = jest.fn(() => {
      throw new Error('boom');
    });
    const hookB = jest.fn();
    manager.registerWipeHook(hookA);
    const unregister = manager.registerWipeHook(hookB);
    await manager.signOut();
    expect(manager.getState().status).toBe('signedOut');
    expect(await store.load()).toBeNull();
    expect(hookA).toHaveBeenCalledTimes(1);
    expect(hookB).toHaveBeenCalledTimes(1);
    if (tokens)
      await expect(client.getSession(tokens.accessToken)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
    unregister();
  });

  it('signOut still wipes locally when the server call fails', async () => {
    const { client, store } = setup();
    const failing: AuthClient = { ...client, logout: () => Promise.reject(new Error('offline')) };
    const manager = createSessionManager({ client: failing, store });
    await manager.signIn(account);
    await manager.signOut();
    expect(await store.load()).toBeNull();
  });

  it('getAccessToken refreshes once for concurrent callers', async () => {
    const { client, manager, advance } = setup({ accessTtlSeconds: 60 });
    await manager.signIn(account);
    advance(120_000);
    const spy = jest.spyOn(client, 'refresh');
    const [a, b] = await Promise.all([manager.getAccessToken(), manager.getAccessToken()]);
    expect(a).toBeTruthy();
    expect(a).toBe(b);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(manager.getState().status).toBe('signedIn');
  });
});

describe('switchOrganization', () => {
  it('rotates to an org-scoped pair, updates the identity and runs wipe hooks', async () => {
    const { client, store, manager } = setup();
    await manager.signIn(account);
    const oldTokens = await store.load();
    const hook = jest.fn();
    manager.registerWipeHook(hook);
    const target = account.organizations[1]?.id ?? '';
    await manager.switchOrganization(target);
    const state = manager.getState();
    expect(state.status).toBe('signedIn');
    if (state.status !== 'signedIn') throw new Error('unreachable');
    expect(state.identity.organizationId).toBe(target);
    expect(state.session.activeOrganizationId).toBe(target);
    expect((await store.load())?.organizationId).toBe(target);
    expect(hook).toHaveBeenCalledTimes(1);
    if (oldTokens)
      await expect(client.getSession(oldTokens.accessToken)).rejects.toMatchObject({
        code: 'UNAUTHENTICATED',
      });
  });

  it('rejects a non-member org with NOT_FOUND and stays on the current org', async () => {
    const { manager } = setup();
    await manager.signIn(account);
    await expect(
      manager.switchOrganization('00000000-0000-4000-8000-0000000000ff'),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    const state = manager.getState();
    expect(state.status === 'signedIn' && state.identity.organizationId).toBe(
      account.organizations[0]?.id,
    );
  });
});
