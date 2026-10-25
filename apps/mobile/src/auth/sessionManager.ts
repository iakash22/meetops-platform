import type { MobileSession } from '../config/session';
import type { TokenStore } from './tokenStore';
import {
  AuthClientError,
  isAuthClientError,
  type AuthClient,
  type LoginCredentials,
  type MobileAuthSession,
  type MobileAuthTokens,
} from './types';

export type AuthState =
  | { status: 'loading' }
  | { status: 'signedOut' }
  | { status: 'signedIn'; session: MobileAuthSession; identity: MobileSession };

/** Runs on sign-out and on any forced sign-out (R4: wipe everything on logout / org switch). Must not throw. */
export type WipeHook = () => void | Promise<void>;

export interface SessionManager {
  getState: () => AuthState;
  subscribe: (listener: () => void) => () => void;
  /** Reads stored tokens and resolves the session. Call once at startup. */
  restore: () => Promise<void>;
  /** Throws `AuthClientError` on failure; state stays `signedOut`. */
  signIn: (credentials: LoginCredentials) => Promise<void>;
  signOut: () => Promise<void>;
  /**
   * Switches the active organization. Runs the wipe hooks first (R4: local data of the old org is wiped on switch),
   * then stores the new org-scoped pair. On an auth failure the user is signed out.
   */
  switchOrganization: (organizationId: string) => Promise<void>;
  /** A non-expired access token for API calls, refreshing if needed. Null (and signed out) if the session is gone. */
  getAccessToken: () => Promise<string | null>;
  registerWipeHook: (hook: WipeHook) => () => void;
}

export interface SessionManagerOptions {
  client: AuthClient;
  store: TokenStore;
  now?: () => number;
  /** Refresh this many ms before the access token expires. */
  refreshSkewMs?: number;
}

const isAuthFailure = (e: unknown) =>
  isAuthClientError(e) &&
  (e.code === 'UNAUTHENTICATED' || e.code === 'AUTH_FAILED' || e.code === 'FORBIDDEN');

export function toIdentity(
  session: MobileAuthSession,
  tokens: MobileAuthTokens,
): MobileSession | null {
  const organizationId = session.activeOrganizationId;
  // The token is org-scoped; a mismatch means a stale pair, so treat it as signed out.
  if (!organizationId || organizationId !== tokens.organizationId) return null;
  return { userId: session.user.id, organizationId };
}

export function createSessionManager({
  client,
  store,
  now = () => Date.now(),
  refreshSkewMs = 30_000,
}: SessionManagerOptions): SessionManager {
  let state: AuthState = { status: 'loading' };
  const listeners = new Set<() => void>();
  const wipeHooks = new Set<WipeHook>();
  let refreshing: Promise<MobileAuthTokens | null> | null = null;

  const setState = (next: AuthState) => {
    state = next;
    listeners.forEach((l) => l());
  };

  const runWipeHooks = async () => {
    for (const hook of [...wipeHooks]) {
      try {
        await hook();
      } catch {
        // A failing hook must not keep the user signed in. Hooks own their own error reporting.
      }
    }
  };

  const wipe = async () => {
    await store.clear();
    await runWipeHooks();
    setState({ status: 'signedOut' });
  };

  const isExpired = (tokens: MobileAuthTokens) =>
    Date.parse(tokens.expiresAt) - refreshSkewMs <= now();

  /** Single-flight refresh: concurrent callers share one rotation (a second rotation would look like reuse). */
  const refresh = (tokens: MobileAuthTokens): Promise<MobileAuthTokens | null> => {
    refreshing ??= (async () => {
      try {
        if (Date.parse(tokens.refreshExpiresAt) <= now())
          throw new AuthClientError('UNAUTHENTICATED');
        const next = await client.refresh(tokens.refreshToken);
        await store.save(next);
        return next;
      } catch (e) {
        if (isAuthFailure(e)) {
          await wipe();
          return null;
        }
        throw e;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  };

  const activate = async (tokens: MobileAuthTokens, session: MobileAuthSession) => {
    const identity = toIdentity(session, tokens);
    if (!identity) {
      await wipe();
      throw new AuthClientError('FORBIDDEN', 'No active organization for this account.');
    }
    setState({ status: 'signedIn', session, identity });
  };

  const getAccessToken = async (): Promise<string | null> => {
    let tokens = await store.load();
    if (!tokens) return null;
    if (isExpired(tokens)) tokens = await refresh(tokens);
    return tokens?.accessToken ?? null;
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async restore() {
      let tokens = await store.load();
      if (!tokens) return setState({ status: 'signedOut' });
      try {
        if (isExpired(tokens)) tokens = await refresh(tokens);
        if (!tokens) return;
        await activate(tokens, await client.getSession(tokens.accessToken));
      } catch (e) {
        // Auth failures wipe; anything else (offline, 5xx) keeps the tokens for the next attempt.
        if (isAuthFailure(e)) await wipe();
        else setState({ status: 'signedOut' });
      }
    },

    async signIn(credentials) {
      const { tokens, session } = await client.login(credentials);
      await store.save(tokens);
      await activate(tokens, session);
    },

    async signOut() {
      const tokens = await store.load();
      if (tokens) {
        try {
          await client.logout(tokens.refreshToken);
        } catch {
          // Best effort: the local wipe below always happens, even offline.
        }
      }
      await wipe();
    },

    async switchOrganization(organizationId) {
      if (state.status !== 'signedIn') throw new AuthClientError('UNAUTHENTICATED');
      const current = state;
      if (current.identity.organizationId === organizationId) return;
      const accessToken = await getAccessToken();
      if (!accessToken) throw new AuthClientError('UNAUTHENTICATED');
      let result;
      try {
        result = await client.switchOrganization(accessToken, organizationId);
      } catch (e) {
        if (isAuthClientError(e) && e.code === 'UNAUTHENTICATED') await wipe();
        throw e;
      }
      await runWipeHooks();
      await store.save(result.tokens);
      await activate(result.tokens, {
        ...current.session,
        activeOrganizationId: result.organization.id,
        role: result.role,
      });
    },

    getAccessToken,

    registerWipeHook(hook) {
      wipeHooks.add(hook);
      return () => wipeHooks.delete(hook);
    },
  };
}
