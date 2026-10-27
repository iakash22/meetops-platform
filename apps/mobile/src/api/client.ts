import type {
  ApiErrorCode,
  ApiErrorEnvelope,
  AuthSession,
  GetAuthSessionResponse,
  ListOrganizationsResponse,
  LoginRequest,
  OrganizationWithRole,
  SignupRequest,
  SwitchOrganizationRequest,
} from '@meetops/contracts';

/**
 * Typed client for the MeetOps API, using `@meetops/contracts` types (type-only: no TypeBox in the bundle).
 *
 * NOT WIRED INTO THE APP YET. The API authenticates with a `__Host-` cookie + CSRF today; the mobile bearer flow is
 * blocked on the ADR-005 mobile amendment. This client already follows the bearer rules (ADR-005 A1.3): the token goes
 * only in the `Authorization` header, never in a URL, and `credentials: 'omit'` so no cookie is sent. Once Backend
 * ships bearer auth for mobile, an `AuthClient` adapter wraps this client and replaces the mock.
 *
 * Shapes match the real routes:
 * - `POST /auth/signup` -> 202 `{ message }`, enumeration-safe, and it does NOT start a session (log in afterwards).
 * - `POST /auth/login` -> 200 `AuthSession`.
 * - `GET /auth/session` -> 200 `GetAuthSessionResponse`.
 * - `POST /orgs/switch` -> 200 `OrganizationWithRole` (`{ organization, role }`), 404 for non-members.
 * - `GET /orgs` -> 200 `ListOrganizationsResponse`.
 * - `POST /auth/logout` -> 204.
 */
/**
 * Every value `error.reason` may take, derived from the contracts `ApiErrorEnvelope` schema type (TypeBox `Static`)
 * instead of a hand-written list, so new reasons added to `@meetops/contracts` (e.g. v0.4.0 `NOT_FOUND` reasons and
 * directory `CONFLICT` reasons) flow through without a mobile change.
 */
export type ApiErrorReason = NonNullable<ApiErrorEnvelope['error']['reason']>;

export interface SignupAccepted {
  message: string;
}

export interface ApiClientOptions {
  /** https origin of the API, no trailing slash. */
  baseUrl: string;
  /** Returns the current bearer token or null. Never logged. */
  getAccessToken?: () => Promise<string | null>;
  fetchImpl?: typeof fetch;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode;
  readonly requestId: string | undefined;
  readonly reason: ApiErrorReason | undefined;

  constructor(
    status: number,
    code: ApiErrorCode,
    message: string,
    requestId?: string,
    reason?: ApiErrorReason,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.reason = reason;
  }
}

const statusToCode = (status: number): ApiErrorCode => {
  if (status === 400) return 'BAD_REQUEST';
  if (status === 401) return 'UNAUTHENTICATED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 429) return 'RATE_LIMITED';
  return 'INTERNAL';
};

const isEnvelope = (body: unknown): body is ApiErrorEnvelope =>
  typeof body === 'object' &&
  body !== null &&
  'error' in body &&
  typeof body.error === 'object' &&
  typeof (body as { error: { code?: unknown } }).error.code === 'string';

/** Low-level typed requester shared by `createApiClient`, the HTTP auth client and the HTTP repositories. */
export function createApiRequester({ baseUrl, getAccessToken, fetchImpl }: ApiClientOptions) {
  const doFetch = fetchImpl ?? fetch;
  const origin = baseUrl.replace(/\/+$/, '');

  return async function request<T>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    expect = 200,
  ): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    const token = getAccessToken ? await getAccessToken() : null;
    if (token) headers.authorization = `Bearer ${token}`;

    const res = await doFetch(`${origin}${path}`, {
      method,
      headers,
      credentials: 'omit',
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = res.status === 204 ? '' : await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }

    if (res.status !== expect) {
      if (isEnvelope(parsed)) {
        const { code, message, requestId, reason } = parsed.error;
        throw new ApiError(res.status, code, message, requestId, reason);
      }
      throw new ApiError(res.status, statusToCode(res.status), `Request failed (${res.status}).`);
    }
    return parsed as T;
  };
}

export function createApiClient(options: ApiClientOptions) {
  const request = createApiRequester(options);
  return {
    /** Typed escape hatch for routes without a named method (same auth, envelope and error mapping). */
    request,
    signup: (body: SignupRequest) => request<SignupAccepted>('POST', '/auth/signup', body, 202),
    login: (body: LoginRequest) => request<AuthSession>('POST', '/auth/login', body),
    getSession: () => request<GetAuthSessionResponse>('GET', '/auth/session'),
    listOrganizations: () => request<ListOrganizationsResponse>('GET', '/orgs'),
    switchOrganization: (body: SwitchOrganizationRequest) =>
      request<OrganizationWithRole>('POST', '/orgs/switch', body),
    logout: () => request<void>('POST', '/auth/logout', undefined, 204),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
