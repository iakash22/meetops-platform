import type {
  ApiErrorCode as ContractApiErrorCode,
  CreateUploadRequest,
  CreateUploadResponse,
  CsrfResponse,
} from '@meetops/contracts';
import type {
  AuthSession,
  ForgotPasswordRequest,
  ID,
  LoginRequest,
  Meeting,
  Organization,
  Paginated,
  Project,
  SignupRequest,
  Task,
} from './types';

/** Contracts ApiErrorEnvelope codes plus 'UNKNOWN' when the body is unparseable. */
export type ApiErrorCode = ContractApiErrorCode | 'UNKNOWN';

const KNOWN_CODES = new Set<string>([
  'BAD_REQUEST',
  'AUTH_FAILED',
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'INTERNAL',
]);

/**
 * Error from the API. `message` is the server-provided envelope message (never
 * method/path/parse details). UI must not render it; use the code mapping instead.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly requestId: string | undefined;
  constructor(
    public readonly status: number,
    code: ApiErrorCode,
    message: string,
    requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.requestId = requestId;
  }

  /** Parse `{ error: { code, message, requestId? } }`; tolerate anything else. */
  static fromResponse(status: number, body: unknown): ApiError {
    const env = body && typeof body === 'object' && 'error' in body ? body.error : undefined;
    const e = env && typeof env === 'object' ? (env as Record<string, unknown>) : {};
    const code =
      typeof e.code === 'string' && KNOWN_CODES.has(e.code)
        ? (e.code as ApiErrorCode)
        : status === 401
          ? 'UNAUTHENTICATED'
          : 'UNKNOWN';
    const message = typeof e.message === 'string' ? e.message : 'Request failed';
    const requestId = typeof e.requestId === 'string' ? e.requestId : undefined;
    return new ApiError(status, code, message, requestId);
  }
}

function safeJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export type ApiClientOptions = {
  baseUrl: string;
  fetch?: typeof fetch;
  /** Override how the CSRF token is read (defaults to cookie, then GET /auth/csrf). */
  getCsrfToken?: () => Promise<string | null> | string | null;
};

/** Methods that must carry X-CSRF-Token (docs/12-security/auth-session-spec.md §4). */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
export const CSRF_HEADER = 'X-CSRF-Token';
/** Double-submit cookie names: `__Host-` in prod, unprefixed in dev over http. */
export const CSRF_COOKIE_NAMES = ['__Host-meetops_csrf', 'meetops_csrf'] as const;

export function readCsrfCookie(
  cookieString: string = globalThis.document?.cookie ?? '',
): string | null {
  for (const part of cookieString.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    if ((CSRF_COOKIE_NAMES as readonly string[]).includes(name)) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

export type HttpMethod = 'GET' | 'HEAD' | 'OPTIONS' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Typed API client surface. */
export type ApiClient = {
  auth: {
    login: (body: LoginRequest) => Promise<AuthSession>;
    signup: (body: SignupRequest) => Promise<AuthSession>;
    forgotPassword: (body: ForgotPasswordRequest) => Promise<{ ok: true }>;
  };
  organizations: { list: () => Promise<Organization[]> };
  meetings: { list: (orgId: ID) => Promise<Paginated<Meeting>> };
  tasks: { list: (orgId: ID) => Promise<Paginated<Task>> };
  projects: { list: (orgId: ID) => Promise<Paginated<Project>> };
  /** Low-level request (cookie session + CSRF on non-GET). */
  request: <T>(method: HttpMethod, path: string, body?: unknown) => Promise<T>;
  storage: {
    /** POST /orgs/:organizationId/uploads; returns a presigned PUT (PresignedUrlDto). */
    createUpload: (orgId: ID, body: CreateUploadRequest) => Promise<CreateUploadResponse>;
  };
};

export function createApiClient(options: ApiClientOptions): ApiClient {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const base = options.baseUrl.replace(/\/$/, '');

  // Session is an HttpOnly cookie (__Host-meetops_sid); the browser sends it via
  // credentials: 'include'. No bearer tokens or client-side token storage.
  let cachedCsrf: string | null = null;

  async function fetchCsrfToken(): Promise<string | null> {
    const res = await doFetch(`${base}/auth/csrf`, {
      method: 'GET',
      credentials: 'include',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<CsrfResponse>;
    return data.csrfToken ?? null;
  }

  async function resolveCsrfToken(force = false): Promise<string | null> {
    if (options.getCsrfToken) return options.getCsrfToken();
    const fromCookie = readCsrfCookie();
    if (fromCookie) return fromCookie;
    if (!cachedCsrf || force) cachedCsrf = await fetchCsrfToken();
    return cachedCsrf;
  }

  async function send(
    method: string,
    path: string,
    body: unknown,
    forceCsrf: boolean,
  ): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (!SAFE_METHODS.has(method)) {
      const csrf = await resolveCsrfToken(forceCsrf);
      if (csrf) headers[CSRF_HEADER] = csrf;
    }
    const init: RequestInit = { method, headers, credentials: 'include' };
    if (body !== undefined) init.body = JSON.stringify(body);
    return doFetch(`${base}${path}`, init);
  }

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res = await send(method, path, body, false);
    // A stale synchronizer token yields 403; refresh once and retry.
    if (res.status === 403 && !SAFE_METHODS.has(method) && !options.getCsrfToken) {
      res = await send(method, path, body, true);
    }
    const data = safeJson(await res.text());
    if (!res.ok) throw ApiError.fromResponse(res.status, data);
    return data as T;
  }

  const org = (orgId: ID) => `/orgs/${encodeURIComponent(orgId)}`;

  return {
    request,
    auth: {
      login: (body) => request('POST', '/auth/login', body),
      signup: (body) => request('POST', '/auth/signup', body),
      forgotPassword: (body) => request('POST', '/auth/forgot-password', body),
    },
    organizations: { list: () => request('GET', '/orgs') },
    meetings: { list: (orgId) => request('GET', `${org(orgId)}/meetings`) },
    tasks: { list: (orgId) => request('GET', `${org(orgId)}/tasks`) },
    projects: { list: (orgId) => request('GET', `${org(orgId)}/projects`) },
    storage: {
      createUpload: (orgId, body) => request('POST', `${org(orgId)}/uploads`, body),
    },
  };
}
