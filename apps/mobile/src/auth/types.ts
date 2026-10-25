import type {
  ApiErrorCode,
  GetAuthSessionResponse,
  IsoDateTime,
  LoginRequest,
  OrganizationWithRole,
} from '@meetops/contracts';

/**
 * Mobile auth types.
 *
 * Request and session bodies come from `@meetops/contracts` (type-only imports, so no TypeBox ships in the bundle).
 * The token pair is a LOCAL PLACEHOLDER: contracts only define tokens for the browser extension (ADR-005,
 * `audience: 'extension'`). The mobile bearer flow is blocked on the ADR-005 mobile amendment (Architecture) and the
 * Backend routes. When that lands, replace `MobileAuthTokens` with the contracts type and keep the interfaces below.
 */

/** Credentials the login screen submits. Same shape and limits as the web `POST /auth/login` body. */
export type LoginCredentials = LoginRequest;

/** Token-free session body (same as `GET /auth/session`). Never holds token material. */
export type MobileAuthSession = GetAuthSessionResponse;

/** Placeholder bearer pair, modelled on ADR-005 A1.2 (opaque tokens, rotating refresh, bounded family lifetime). */
export interface MobileAuthTokens {
  tokenType: 'Bearer';
  accessToken: string;
  /** Access token expiry. */
  expiresAt: IsoDateTime;
  refreshToken: string;
  /** Hard bound on the refresh family; after this the user must sign in again. */
  refreshExpiresAt: IsoDateTime;
  organizationId: string;
}

export interface LoginResult {
  tokens: MobileAuthTokens;
  session: MobileAuthSession;
}

/**
 * Org switch result. The real API (`POST /orgs/switch`) returns `OrganizationWithRole` and rotates the session; for
 * bearer clients the token is org-scoped (ADR-005), so a switch must also return a new pair (placeholder).
 */
export interface SwitchOrganizationResult extends OrganizationWithRole {
  tokens: MobileAuthTokens;
}

/**
 * The only seam between the app and the API for auth. Screens and the session manager depend on this interface; the
 * mock (`createMockAuthClient`) implements it today, an HTTP client will implement it once the bearer ADR lands.
 */
export interface AuthClient {
  login(credentials: LoginCredentials): Promise<LoginResult>;
  /** Resolves the session for a valid access token, or throws `UNAUTHENTICATED`. */
  getSession(accessToken: string): Promise<MobileAuthSession>;
  /** Rotates: consumes `refreshToken` and returns a new pair. Reuse of a consumed token revokes the family. */
  refresh(refreshToken: string): Promise<MobileAuthTokens>;
  /** Switches the active organization. Requires membership (NOT_FOUND otherwise). Revokes the old token family. */
  switchOrganization(
    accessToken: string,
    organizationId: string,
  ): Promise<SwitchOrganizationResult>;
  /** Revokes the refresh family. Must not throw for an already-revoked token. */
  logout(refreshToken: string): Promise<void>;
}

/** Error raised by an `AuthClient`. `code` uses the shared API error codes. The message never includes credentials. */
export class AuthClientError extends Error {
  readonly code: ApiErrorCode;

  constructor(code: ApiErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'AuthClientError';
    this.code = code;
  }
}

export const isAuthClientError = (e: unknown): e is AuthClientError => e instanceof AuthClientError;
