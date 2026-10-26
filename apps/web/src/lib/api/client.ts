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
  ListMembersResponse,
  ListOrganizationsResponse,
  ListSessionsResponse,
  Membership,
  Role,
  LoginRequest,
  Meeting,
  Paginated,
  PresignedUrlDto,
  SignupRequest,
  Task,
  ListTasksQuery,
  OrganizationWithRole,
  ResetPasswordRequest,
  SwitchOrganizationRequest,
  VerifyEmailRequest,
} from '@meetops/contracts';
import {
  API_ERROR_CODES,
  CONFLICT_REASONS,
  EXTENSION_AUTH_PATHS,
  type ConflictReason,
} from '@meetops/contracts/types';
import { createHttpDirectoryApi, type DirectoryApi } from '@/features/directory/api';
import {
  DESKTOP_AUTHORIZE_PATH,
  type DesktopAuthorizeRequest,
  type DesktopAuthorizeResponse,
} from '@/features/desktop/authorize';

/** Contracts ApiErrorEnvelope codes plus 'UNKNOWN' when the body is unparseable. */
export type ApiErrorCode = ContractApiErrorCode | 'UNKNOWN';

const KNOWN_CODES = new Set<string>(API_ERROR_CODES);
const KNOWN_REASONS = new Set<string>(CONFLICT_REASONS);

/**
 * Error from the API. `message` is the server-provided envelope message (never
 * method/path/parse details). UI must not render it; use the code mapping instead.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly requestId: string | undefined;
  readonly details: ReadonlyArray<{ path: string; message: string }>;
  /** 409 sub-reason (contracts CONFLICT_REASONS, e.g. LAST_OWNER), when the envelope carries a known one. */
  reason: ConflictReason | undefined = undefined;
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
    const error = new ApiError(status, code, message, requestId, details);
    if (typeof e.reason === 'string' && KNOWN_REASONS.has(e.reason))
      error.reason = e.reason as ConflictReason;
    return error;
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

/**
 * 202 body of the enumeration-safe auth endpoints (signup, forgot-password,
 * resend-verification). The API's `AcceptedBody`; not in contracts yet.
 */
export type AcceptedResponse = { message: string };

/** POST /invitations/accept body (the API's `AcceptInvitationBody`; not in contracts yet). */
export type AcceptInvitationRequest = { token: string };

/** Roles an invitation may grant (the API's `InvitableRole`; owners are only created with the org). */
export type InvitableRole = Exclude<Role, 'owner'>;

/** POST /orgs/:organizationId/invitations body (the API's `CreateInvitationBody`; not in contracts yet). */
export type CreateInvitationRequest = { email: string; role: InvitableRole };

/** The API's `InvitationDto` (not in contracts yet). The token is never returned; it is only emailed. */
export type Invitation = {
  id: Id;
  organizationId: Id;
  email: string;
  role: InvitableRole;
  status: 'pending' | 'accepted' | 'revoked';
  expiresAt: string;
};

/** Cursor page params for GET list endpoints (contracts CursorPageQuery). */
export type CursorParams = { cursor?: string | undefined; limit?: number | undefined };

/** GET /orgs/:id/tasks query (contracts ListTasksQuery; `unassigned` excludes `assigneeId`). */
export type TaskListFilters = ListTasksQuery;

/** Typed API client surface. */
export type ApiClient = {
  auth: {
    login: (body: LoginRequest) => Promise<AuthSession>;
    /**
     * POST /auth/signup: always 202 `{ message }` (enumeration-safe). No session is
     * started; the user verifies their email and then logs in.
     */
    signup: (body: SignupRequest) => Promise<AcceptedResponse>;
    forgotPassword: (body: ForgotPasswordRequest) => Promise<void>;
    /** POST /auth/reset-password (204). The API revokes every session of the user. */
    resetPassword: (body: ResetPasswordRequest) => Promise<void>;
    /** POST /auth/verify-email (204). Public; 400 BAD_REQUEST for an invalid/expired token. */
    verifyEmail: (body: VerifyEmailRequest) => Promise<void>;
    /** POST /auth/resend-verification: always 202 (enumeration-safe). */
    resendVerification: (body: ForgotPasswordRequest) => Promise<void>;
    /** POST /auth/logout (204): revokes this session and clears the cookie. */
    logout: () => Promise<void>;
    /** POST /auth/logout-all (204): revokes every session of the caller, this one included. */
    logoutAll: () => Promise<void>;
    /** GET /auth/session; 401 when signed out. */
    session: () => Promise<GetAuthSessionResponse>;
    /** GET /auth/sessions: cursor page of the caller's active sessions; `current` marks this one. */
    sessions: (page?: CursorParams) => Promise<ListSessionsResponse>;
    /**
     * DELETE /auth/sessions/:sessionId (204). 404 for unknown or other users' sessions.
     * Revoking the current session also clears the cookie (the caller is signed out).
     */
    revokeSession: (sessionId: Id) => Promise<void>;
  };
  organizations: {
    /** GET /orgs: cursor page of `{ organization, role }`. */
    list: () => Promise<ListOrganizationsResponse>;
    /** POST /orgs. The server rotates the session into the new org and issues a new CSRF token. */
    create: (body: CreateOrganizationRequest) => Promise<CreateOrganizationResponse>;
    /**
     * POST /orgs/switch: returns `{ organization, role }` (not an AuthSession). The
     * server rotates the session and sets a new CSRF cookie; callers refetch
     * GET /auth/session afterwards.
     */
    switch: (body: SwitchOrganizationRequest) => Promise<OrganizationWithRole>;
  };
  invitations: {
    /**
     * POST /invitations/accept: needs a session for the invited, verified email.
     * Unknown/expired/revoked/mismatched tokens are 404; already a member is 409.
     */
    accept: (body: AcceptInvitationRequest) => Promise<OrganizationWithRole>;
    /**
     * POST /orgs/:organizationId/invitations (201). Owner/admin only. Re-inviting the
     * same address replaces its pending invite (this is how "resend" works: there is
     * no separate resend route). 409 ALREADY_MEMBER for an active member.
     */
    create: (organizationId: Id, body: CreateInvitationRequest) => Promise<Invitation>;
    /** POST /orgs/:organizationId/invitations/:invitationId/revoke. Pending invitations only (else 409). */
    revoke: (organizationId: Id, invitationId: Id) => Promise<Invitation>;
  };
  members: {
    /** GET /orgs/:organizationId/members: cursor page; `user.email` only for owner/admin viewers. 404 for non-members. */
    list: (organizationId: Id, page?: CursorParams) => Promise<ListMembersResponse>;
    /**
     * PATCH /orgs/:organizationId/members/:userId. 403 outside the role rules, 409 LAST_OWNER.
     * Changing your own role rotates your session.
     */
    changeRole: (organizationId: Id, userId: Id, role: Role) => Promise<Membership>;
    /** DELETE /orgs/:organizationId/members/:userId (204). Removing yourself leaves the org (session rotates). */
    remove: (organizationId: Id, userId: Id) => Promise<void>;
  };
  extension: {
    /** POST /auth/extension/pair (ADR-005 A1.1). Cookie + CSRF; returns a single-use pairing code. */
    pair: (body: ExtensionPairRequest) => Promise<ExtensionPairResponse>;
  };
  desktop: {
    /**
     * POST /auth/desktop/authorize (ADR-012 §1.4, Proposed). Cookie + CSRF; returns a single-use code for the
     * loopback redirect. Not served by the API yet, so callers must handle 404/network errors.
     */
    authorize: (body: DesktopAuthorizeRequest) => Promise<DesktopAuthorizeResponse>;
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
  '/auth/reset-password',
  '/auth/verify-email',
  '/auth/resend-verification',
  '/auth/logout',
  '/auth/logout-all',
  '/invitations/accept',
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
    // Session rotates on login; use the token the server just issued.
    cachedCsrf = session.csrfToken;
    return session;
  }

  const org = (id: Id) => `/orgs/${encodeURIComponent(id)}`;

  function pageQuery(page: CursorParams = {}): string {
    const q = new URLSearchParams();
    if (page.cursor) q.set('cursor', page.cursor);
    if (page.limit !== undefined) q.set('limit', String(page.limit));
    const s = q.toString();
    return s ? `?${s}` : '';
  }

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
      // 202 with no session: the cached CSRF token stays as is.
      signup: (body) => request<AcceptedResponse>('POST', '/auth/signup', body),
      forgotPassword: async (body) => {
        await request('POST', '/auth/forgot-password', body);
      },
      resetPassword: async (body) => {
        await request('POST', '/auth/reset-password', body);
        // All sessions were revoked server-side; drop the token bound to the old one.
        cachedCsrf = null;
      },
      verifyEmail: async (body) => {
        await request('POST', '/auth/verify-email', body);
      },
      resendVerification: async (body) => {
        await request('POST', '/auth/resend-verification', body);
      },
      logout: async () => {
        try {
          await request('POST', '/auth/logout');
        } finally {
          cachedCsrf = null;
        }
      },
      logoutAll: async () => {
        try {
          await request('POST', '/auth/logout-all');
        } finally {
          cachedCsrf = null;
        }
      },
      session: () => request('GET', '/auth/session'),
      sessions: (page) => request('GET', `/auth/sessions${pageQuery(page)}`),
      revokeSession: async (sessionId) => {
        await request('DELETE', `/auth/sessions/${encodeURIComponent(sessionId)}`);
        // If this was the current session its cookie is gone; never reuse its token.
        cachedCsrf = null;
      },
    },
    organizations: {
      list: () => request('GET', '/orgs'),
      create: async (body) => {
        const res = await request<CreateOrganizationResponse>('POST', '/orgs', body);
        // Session rotated server-side: drop the old CSRF token so the next write refetches it.
        cachedCsrf = null;
        return res;
      },
      switch: async (body) => {
        const res = await request<OrganizationWithRole>('POST', '/orgs/switch', body);
        // Session rotated server-side (new CSRF cookie): drop the old cached token.
        cachedCsrf = null;
        return res;
      },
    },
    invitations: {
      accept: (body) => request('POST', '/invitations/accept', body),
      create: (id, body) => request('POST', `${org(id)}/invitations`, body),
      revoke: (id, invitationId) =>
        request('POST', `${org(id)}/invitations/${encodeURIComponent(invitationId)}/revoke`),
    },
    members: {
      list: (id, page) => request('GET', `${org(id)}/members${pageQuery(page)}`),
      changeRole: async (id, userId, role) => {
        const res = await request<Membership>(
          'PATCH',
          `${org(id)}/members/${encodeURIComponent(userId)}`,
          { role },
        );
        // A self role change rotates the session (new CSRF cookie): drop the cached token.
        cachedCsrf = null;
        return res;
      },
      remove: async (id, userId) => {
        await request('DELETE', `${org(id)}/members/${encodeURIComponent(userId)}`);
        cachedCsrf = null;
      },
    },
    extension: {
      pair: (body) => request('POST', EXTENSION_AUTH_PATHS.pair, body),
    },
    desktop: {
      authorize: (body) => request('POST', DESKTOP_AUTHORIZE_PATH, body),
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
