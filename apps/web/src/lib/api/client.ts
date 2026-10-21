import type { PresignedUrl } from '@meetops/contracts';
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
  Task
} from './types';

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export type ApiClientOptions = {
  baseUrl: string;
  fetch?: typeof fetch;
  getToken?: () => string | null | undefined;
};

/** Typed API client surface. Endpoints are stubs until the API contracts land. */
export type ApiClient = {
  auth: {
    login(body: LoginRequest): Promise<AuthSession>;
    signup(body: SignupRequest): Promise<AuthSession>;
    forgotPassword(body: ForgotPasswordRequest): Promise<{ ok: true }>;
  };
  organizations: { list(): Promise<Organization[]> };
  meetings: { list(orgId: ID): Promise<Paginated<Meeting>> };
  tasks: { list(orgId: ID): Promise<Paginated<Task>> };
  projects: { list(orgId: ID): Promise<Paginated<Project>> };
  storage: {
    /** Uses PresignedUrl from @meetops/contracts. */
    createUploadUrl(orgId: ID, body: { fileName: string; contentType: string }): Promise<PresignedUrl>;
  };
};

export function createApiClient(options: ApiClientOptions): ApiClient {
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  const base = options.baseUrl.replace(/\/$/, '');

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const token = options.getToken?.();
    if (token) headers.Authorization = `Bearer ${token}`;

    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    const res = await doFetch(`${base}${path}`, init);
    const text = await res.text();
    const data: unknown = text ? JSON.parse(text) : undefined;
    if (!res.ok) throw new ApiError(`Request failed: ${method} ${path} (${res.status})`, res.status, data);
    return data as T;
  }

  const org = (orgId: ID) => `/orgs/${encodeURIComponent(orgId)}`;

  return {
    auth: {
      login: (body) => request('POST', '/auth/login', body),
      signup: (body) => request('POST', '/auth/signup', body),
      forgotPassword: (body) => request('POST', '/auth/forgot-password', body)
    },
    organizations: { list: () => request('GET', '/orgs') },
    meetings: { list: (orgId) => request('GET', `${org(orgId)}/meetings`) },
    tasks: { list: (orgId) => request('GET', `${org(orgId)}/tasks`) },
    projects: { list: (orgId) => request('GET', `${org(orgId)}/projects`) },
    storage: {
      createUploadUrl: (orgId, body) => request('POST', `${org(orgId)}/uploads`, body)
    }
  };
}
