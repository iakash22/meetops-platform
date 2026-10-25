import type {
  ApiErrorCode as ContractApiErrorCode,
  AuthSession,
  CreateOrganizationRequest,
  CreateOrganizationResponse,
  CreateUploadRequest,
  CreateUploadResponse,
  CsrfResponse,
  ExtensionPairRequest,
  ExtensionPairResponse,
  ForgotPasswordRequest,
  GetAuthSessionResponse,
  Id,
  ListOrganizationsResponse,
  LoginRequest,
  Meeting,
  Paginated,
  PresignedUrlDto,
  SignupRequest,
  Task,
  ListTasksQuery,
  SwitchOrganizationRequest,
} from '@meetops/contracts';
import { API_ERROR_CODES, EXTENSION_AUTH_PATHS } from '@meetops/contracts/types';
import { createHttpDirectoryApi, type DirectoryApi } from '@/features/directory/api';

/** Contracts ApiErrorEnvelope codes plus 'UNKNOWN' when the body is unparseable. */
export type ApiErrorCode = ContractApiErrorCode | 'UNKNOWN';

const KNOWN_CODES = new Set<string>(API_ERROR_CODES);

/**
 * Error from the API. `message` is the server-provided envelope message (never
 * method/path/parse details). UI must not render it; use the code mapping instead.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly requestId: string | undefined;
  readonly details: ReadonlyArray<{ path: string; message: string }>;
  constructor(
    public readonly status: number,
    code: ApiErrorCode,
    message: string,
    requestId?: string,
    details: ReadonlyArray<{ path: string; message: string }> = [],
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.requestId = requestId;
    this.details = details;
  }

  /** CSRF rejection (contracts v0.3): 403 CSRF_INVALID. Plain FORBIDDEN is never retried. */
  get isCsrfFailure(): boolean {
    return this.status === 403 && this.code === 'CSRF_INVALID';
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
    const details = Array.isArray(e.details)
      ? (e.details as unknown[]).flatMap((d) =>
          d &&
          typeof d === 'object' &&
          typeof (d as Record<string, unknown>).path === 'string' &&
          typeof (d as Record<string, unknown>).message === 'string'
            ? [d as { path: string; message: string }]
            : [],
        )
      : [];
    return new ApiError(status, code, message, requestId, details);
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

/** Thrown before a mutating request is sent when no CSRF token is available. */
export class CsrfUnavailableError extends ApiError {
  constructor() {
    super(0, 'UNKNOWN', 'CSRF token unavailable');
    this.name = 'CsrfUnavailableError';
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

export type { CreateOrganizationRequest, CreateOrganizationResponse, ListOrganizationsResponse };

/** GET /orgs/:id/tasks query (contracts ListTasksQuery; `unassigned` excludes `assigneeId`). */
export type TaskListFilters = ListTasksQuery;

/** Typed API client surface. */
export type ApiClient = {
  auth: {
    login: (body: LoginRequest) => Promise<AuthSession>;
    signup: (body: SignupRequest) => Promise<AuthSession>;
    forgotPassword: (body: ForgotPasswordRequest) => Promise<void>;
    /** GET /auth/session; 401 when signed out. */
    session: () => Promise<GetAuthSessionResponse>;
    /** POST /auth/switch-org. Session and CSRF token rotate; the returned csrfToken is reused. */
    switchOrganization: (body: SwitchOrganizationRequest) => Promise<AuthSession>;
  };
  organizations: {
    /** GET /orgs: cursor page of `{ organization, role }`. */
    list: () => Promise<ListOrganizationsResponse>;
    /** POST /orgs. The server rotates the session into the new org and issues a new CSRF token. */
    create: (body: CreateOrganizationRequest) => Promise<CreateOrganizationResponse>;
  };
  extension: {
    /** POST /auth/extension/pair (ADR-005 A1.1). Cookie + CSRF; returns a single-use pairing code. */
    pair: (body: ExtensionPairRequest) => Promise<ExtensionPairResponse>;
  };
  meetings: {
    list: (organizationId: Id) => Promise<Paginated<Meeting>>;
    get: (organizationId: Id, meetingId: Id) => Promise<Meeting>;
  };
  tasks: {
    list: (organizationId: Id, filters?: TaskListFilters) => Promise<Paginated<Task>>;
  };
  /** Employees, teams, team members and projects (contracts v0.4 directory, BE-3). */
  directory: DirectoryApi;
  /** Low-level request (cookie session + CSRF on non-GET). */
  request: <T>(method: HttpMethod, path: string, body?: unknown) => Promise<T>;
  storage: {
    /** POST /orgs/:organizationId/uploads; returns a presigned PUT (PresignedUrlDto). */
    createUpload: (organizationId: Id, body: CreateUploadRequest) => Promise<CreateUploadResponse>;
    /** PUT the file to object storage. No cookies, no CSRF (third-party origin). */
    putToPresignedUrl: (upload: PresignedUrlDto, file: Blob) => Promise<void>;
  };
  /** Register a handler for 401 responses (excluding auth endpoints). Returns unsubscribe. */
  onUnauthorized: (handler: () => void) => () => void;
};

/** Endpoints whose 401 is an expected result, not a session expiry. */
const AUTH_PATHS = new Set([
  '/auth/login',
  '/auth/signup',
  '/auth/forgot-password',
  '/auth/session',
  '/auth/csrf',
]);

export function createApiClient(options: ApiClientOptions): ApiClient {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const base = options.baseUrl.replace(/\/$/, '');
  const unauthorizedHandlers = new Set<() => void>();

  // Session is an HttpOnly cookie (__Host-meetops_sid); the browser sends it via
  // credentials: 'include'. No bearer tokens or client-side token storage.
  let cachedCsrf: string | null = null;

  async function fetchCsrfToken(): Promise<string | null> {
    try {
      const res = await doFetch(`${base}/auth/csrf`, {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) return null;
      const data = safeJson(await res.text()) as Partial<CsrfResponse> | undefined;
      return typeof data?.csrfToken === 'string' && data.csrfToken ? data.csrfToken : null;
    } catch {
      return null;
    }
  }

  async function resolveCsrfToken(force = false): Promise<string | null> {
    if (options.getCsrfToken) return options.getCsrfToken();
    // On a CSRF_INVALID retry the cookie value is the one just rejected: skip it.
    const fromCookie = force ? null : readCsrfCookie();
    if (fromCookie) return fromCookie;
    if (!cachedCsrf || force) cachedCsrf = await fetchCsrfToken();
    return cachedCsrf;
  }

  async function send(method: string, path: string, body: unknown, forceCsrf: boolean) {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (!SAFE_METHODS.has(method)) {
      const csrf = await resolveCsrfToken(forceCsrf);
      // Never send a state-changing request without a CSRF token.
      if (!csrf) throw new CsrfUnavailableError();
      headers[CSRF_HEADER] = csrf;
    }
    const init: RequestInit = { method, headers, credentials: 'include' };
    if (body !== undefined) init.body = JSON.stringify(body);
    return doFetch(`${base}${path}`, init);
  }

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res = await send(method, path, body, false);
    let data = safeJson(await res.text());
    // Retry once, with a fresh token, only for CSRF-specific rejections.
    if (
      res.status === 403 &&
      !SAFE_METHODS.has(method) &&
      !options.getCsrfToken &&
      ApiError.fromResponse(403, data).isCsrfFailure
    ) {
      res = await send(method, path, body, true);
      data = safeJson(await res.text());
    }
    if (!res.ok) {
      if (res.status === 401 && !AUTH_PATHS.has(path)) {
        cachedCsrf = null;
        unauthorizedHandlers.forEach((h) => h());
      }
      throw ApiError.fromResponse(res.status, data);
    }
    return data as T;
  }

  async function authRequest(path: string, body: unknown): Promise<AuthSession> {
    const session = await request<AuthSession>('POST', path, body);
    // Session rotates on login/signup; use the token the server just issued.
    cachedCsrf = session.csrfToken;
    return session;
  }

  const org = (id: Id) => `/orgs/${encodeURIComponent(id)}`;

  function taskQuery(filters: TaskListFilters = {}): string {
    const q = new URLSearchParams();
    type Scalar = string | number | boolean;
    for (const [key, value] of Object.entries(filters) as [
      string,
      Scalar | Scalar[] | undefined,
    ][]) {
      if (value === undefined || value === '') continue;
      if (Array.isArray(value)) value.forEach((v) => q.append(key, String(v)));
      else q.set(key, String(value));
    }
    const s = q.toString();
    return s ? `?${s}` : '';
  }

  return {
    request,
    onUnauthorized: (handler) => {
      unauthorizedHandlers.add(handler);
      return () => unauthorizedHandlers.delete(handler);
    },
    auth: {
      login: (body) => authRequest('/auth/login', body),
      signup: (body) => authRequest('/auth/signup', body),
      forgotPassword: async (body) => {
        await request('POST', '/auth/forgot-password', body);
      },
      session: () => request('GET', '/auth/session'),
      switchOrganization: (body) => authRequest('/auth/switch-org', body),
    },
    organizations: {
      list: () => request('GET', '/orgs'),
      create: async (body) => {
        const res = await request<CreateOrganizationResponse>('POST', '/orgs', body);
        // Session rotated server-side: drop the old CSRF token so the next write refetches it.
        cachedCsrf = null;
        return res;
      },
    },
    extension: {
      pair: (body) => request('POST', EXTENSION_AUTH_PATHS.pair, body),
    },
    meetings: {
      list: (id) => request('GET', `${org(id)}/meetings`),
      get: (id, meetingId) =>
        request('GET', `${org(id)}/meetings/${encodeURIComponent(meetingId)}`),
    },
    tasks: { list: (id, filters) => request('GET', `${org(id)}/tasks${taskQuery(filters)}`) },
    directory: createHttpDirectoryApi(request),
    storage: {
      createUpload: (id, body) => request('POST', `${org(id)}/uploads`, body),
      putToPresignedUrl: async (upload, file) => {
        if (!upload.url.startsWith('https://'))
          throw new ApiError(0, 'BAD_REQUEST', 'Insecure upload URL');
        const res = await doFetch(upload.url, {
          method: upload.method,
          headers: { ...(upload.headers ?? {}) },
          body: file,
          credentials: 'omit',
        });
        if (!res.ok) throw new ApiError(res.status, 'UNKNOWN', 'Upload failed');
      },
    },
  };
}
