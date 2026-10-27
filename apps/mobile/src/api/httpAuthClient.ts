import type { LoginRequest, OrganizationWithRole } from '@meetops/contracts';

import {
  AuthClientError,
  type AuthClient,
  type LoginResult,
  type MobileAuthSession,
  type MobileAuthTokens,
} from '../auth/types';
import { ApiError, createApiRequester } from './client';

/**
 * HTTP `AuthClient` for the mobile bearer flow (ADR-005 amendment for `audience: 'mobile'`).
 *
 * BACKEND DEPENDENCY: these routes are not in the API or contracts yet. Paths and bodies below mirror the extension
 * token model (ADR-005 A1.2: opaque tokens, rotating refresh, bounded family) and are the proposal mobile builds against:
 * - `POST /auth/mobile/token`   body `LoginRequest & { deviceId }`   -> 200 `{ tokens, session }`
 * - `POST /auth/mobile/refresh` body `{ deviceId, refreshToken }`    -> 200 `MobileAuthTokens` (not Bearer-authenticated)
 * - `POST /auth/mobile/logout`  body `{ deviceId, refreshToken }`    -> 204 (idempotent)
 * `deviceId` is the stable per-install UUID (ADR-005, same field name as the extension and desktop contracts); the
 * refresh family is bound to it.
 * - `GET  /auth/session`        Bearer                         -> 200 `GetAuthSessionResponse`
 * - `POST /orgs/switch`         Bearer, `{ organizationId }`   -> 200 `OrganizationWithRole & { tokens }`
 * Tokens only ever travel in the `Authorization` header or a JSON body, never in a URL, and are never logged.
 */
export interface HttpAuthClientOptions {
  baseUrl: string;
  fetchImpl?: typeof fetch;
  /** Stable per-install device id, see `src/auth/deviceId.ts`. */
  getDeviceId: () => Promise<string>;
}

const toAuthError = (e: unknown): never => {
  if (e instanceof ApiError) throw new AuthClientError(e.code, e.message);
  // Network failure: no response at all.
  throw new AuthClientError('INTERNAL', 'Network request failed.');
};

export function createHttpAuthClient({
  baseUrl,
  fetchImpl,
  getDeviceId,
}: HttpAuthClientOptions): AuthClient {
  const call = <T>(
    method: 'GET' | 'POST',
    path: string,
    opts: { body?: unknown; token?: string; expect?: number } = {},
  ) =>
    createApiRequester({
      baseUrl,
      fetchImpl,
      getAccessToken: () => Promise.resolve(opts.token ?? null),
    })<T>(method, path, opts.body, opts.expect ?? 200).catch(toAuthError);

  return {
    login: async (credentials: LoginRequest) =>
      call<LoginResult>('POST', '/auth/mobile/token', {
        body: { ...credentials, deviceId: await getDeviceId() },
      }),
    getSession: (accessToken) =>
      call<MobileAuthSession>('GET', '/auth/session', { token: accessToken }),
    refresh: async (refreshToken) =>
      call<MobileAuthTokens>('POST', '/auth/mobile/refresh', {
        body: { deviceId: await getDeviceId(), refreshToken },
      }),
    switchOrganization: (accessToken, organizationId) =>
      call<OrganizationWithRole & { tokens: MobileAuthTokens }>('POST', '/orgs/switch', {
        token: accessToken,
        body: { organizationId },
      }),
    async logout(refreshToken) {
      try {
        await call<void>('POST', '/auth/mobile/logout', {
          body: { deviceId: await getDeviceId(), refreshToken },
          expect: 204,
        });
      } catch (e) {
        // Already revoked or expired is success for logout; the local wipe still runs.
        if (
          e instanceof AuthClientError &&
          (e.code === 'UNAUTHENTICATED' || e.code === 'NOT_FOUND')
        )
          return;
        throw e;
      }
    },
  };
}
