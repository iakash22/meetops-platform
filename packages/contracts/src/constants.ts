/**
 * Plain runtime constants with **no TypeBox import**. Re-exported by the main barrel and by the light
 * `@meetops/contracts/types` entry. Keep this file free of runtime imports (a test guards it).
 */

/** All task statuses, in display order. */
export const TASK_STATUSES = ['todo', 'in_progress', 'done', 'cancelled'] as const;
/** Membership roles. */
export const ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
/** STT router ids (`SttProviderId`). */
export const STT_PROVIDER_IDS = ['assemblyai', 'faster-whisper', 'deepgram'] as const;
/** `TranscriptProviderId`: STT ids plus `'unknown'` (legacy backfilled transcripts only). */
export const TRANSCRIPT_PROVIDER_IDS = [...STT_PROVIDER_IDS, 'unknown'] as const;
/** All `ApiErrorCode` values (kept equal to the schema by a type test). */
export const API_ERROR_CODES = [
  'BAD_REQUEST',
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'AUTH_FAILED',
  'CSRF_INVALID',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'INTERNAL',
] as const;
/** Cursor pagination (v0.3.3): max page size, i.e. the `limit` maximum of CursorPageQuery and OffsetPageQuery. */
export const MAX_PAGE_LIMIT = 100;
/** Default `limit` when the query omits it. */
export const DEFAULT_PAGE_LIMIT = 25;
/** Max length of an opaque `cursor` / `nextCursor`. */
export const MAX_CURSOR_LENGTH = 512;

/**
 * v0.3.3: named reasons for `CONFLICT` errors (HTTP 409). Sent as `error.reason` next to `code: 'CONFLICT'` so clients
 * can branch without parsing `message`.
 * - `ALREADY_MEMBER`: invite or accept for someone who already has an active membership in the organization.
 * - `INVITATION_EXPIRED` / `INVITATION_REVOKED` / `INVITATION_ALREADY_ACCEPTED`: the invitation can no longer be used.
 * - `LAST_OWNER`: the change would leave the organization without an owner.
 * - `EMAIL_TAKEN`: an account with this email address already exists.
 * - `CONFLICT`: generic fallback, so every 409 carries a reason even when nothing more specific applies.
 */
export const CONFLICT_REASONS = [
  'ALREADY_MEMBER',
  'INVITATION_EXPIRED',
  'INVITATION_REVOKED',
  'INVITATION_ALREADY_ACCEPTED',
  'LAST_OWNER',
  'EMAIL_TAKEN',
  'CONFLICT',
  // v0.4.0 (directory)
  'PROJECT_KEY_TAKEN',
  'TEAM_MEMBER_EXISTS',
] as const;
/** HTTP status for every `CONFLICT` error, including all CONFLICT_REASONS. */
export const CONFLICT_HTTP_STATUS = 409;

/**
 * v0.4.0: named reasons for `NOT_FOUND` errors (HTTP 404) on the directory routes. Sent as `error.reason` next to
 * `code: 'NOT_FOUND'`.
 *
 * Tenancy: the API MUST return exactly the same body for an id that does not exist, an id that is soft-deleted and an
 * id that belongs to another organization, so these reasons never reveal whether another tenant's id exists.
 */
export const NOT_FOUND_REASONS = [
  'EMPLOYEE_NOT_FOUND',
  'TEAM_NOT_FOUND',
  'PROJECT_NOT_FOUND',
] as const;
/** HTTP status for every `NOT_FOUND` error, including all NOT_FOUND_REASONS. */
export const NOT_FOUND_HTTP_STATUS = 404;

/**
 * Every value `ApiErrorEnvelope.error.reason` may take: CONFLICT_REASONS (with `code: 'CONFLICT'`) followed by
 * NOT_FOUND_REASONS (with `code: 'NOT_FOUND'`). v0.4.0 widened this from an alias of CONFLICT_REASONS.
 */
export const API_ERROR_REASONS = [...CONFLICT_REASONS, ...NOT_FOUND_REASONS] as const;

/** v0.4.0: the error names the directory routes (employees, teams, projects) can return as `error.reason`. */
export const DIRECTORY_ERROR_REASONS = [
  'EMPLOYEE_NOT_FOUND',
  'TEAM_NOT_FOUND',
  'PROJECT_NOT_FOUND',
  'PROJECT_KEY_TAKEN',
  'TEAM_MEMBER_EXISTS',
] as const;

/** v0.4.0: project lifecycle states (Prisma `ProjectStatus`). */
export const PROJECT_STATUSES = ['active', 'archived'] as const;
/** v0.4.0: a team member's role in the team (Prisma `team_members.role`). Not an org Role. */
export const TEAM_MEMBER_ROLES = ['lead', 'member'] as const;

/** v0.4.0: max length of an employee full name, a team name and a project name. */
export const MAX_DIRECTORY_NAME_LENGTH = 200;
/** v0.4.0: max length of a team or project description. */
export const MAX_DIRECTORY_DESCRIPTION_LENGTH = 2000;
/** v0.4.0: max length of an employee title, department and externalId. */
export const MAX_EMPLOYEE_FIELD_LENGTH = 200;
/** v0.4.0: max length of an email address (RFC 5321 path limit). */
export const MAX_EMAIL_LENGTH = 254;
/**
 * v0.4.0: project and team `key` pattern: an uppercase letter, then 1-9 uppercase letters or digits (e.g. `OPS`, `WEB2`).
 * Clients may upper-case input before sending; the schema does not normalise.
 */
export const DIRECTORY_KEY_PATTERN = '^[A-Z][A-Z0-9]{1,9}$';

/**
 * v0.4.0: directory route templates. Every route is scoped to the organization in the path, and the API MUST check it
 * equals the session's active organization (a mismatch or other-org resource id returns NOT_FOUND, never FORBIDDEN).
 * - `employees` / `teams` / `projects`: GET (cursor page) and POST (create, 201).
 * - `employee` / `team` / `project`: GET, PATCH (partial update) and DELETE (soft delete, 204).
 * - `teamMembers`: GET (cursor page) and POST (add, 201). `teamMember`: PATCH (role) and DELETE (remove, 204).
 */
export const DIRECTORY_PATHS = {
  employees: '/orgs/:organizationId/employees',
  employee: '/orgs/:organizationId/employees/:employeeId',
  teams: '/orgs/:organizationId/teams',
  team: '/orgs/:organizationId/teams/:teamId',
  teamMembers: '/orgs/:organizationId/teams/:teamId/members',
  teamMember: '/orgs/:organizationId/teams/:teamId/members/:employeeId',
  projects: '/orgs/:organizationId/projects',
  project: '/orgs/:organizationId/projects/:projectId',
} as const;

/** ADR-005: extension tokens. TTL of the access token in seconds (15 min). */
export const EXTENSION_TOKEN_TTL_SECONDS = 900;
/** ADR-005 amendment 1: absolute maximum lifetime of a refresh family (30 days), counted from pairing. Not extended by rotation. */
export const EXTENSION_REFRESH_FAMILY_MAX_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
export const EXTENSION_TOKEN_AUDIENCE = 'extension' as const;
export const EXTENSION_TOKEN_TYPE = 'Bearer' as const;
export const EXTENSION_SCOPES = ['meetings:resolve', 'recordings:write'] as const;

/**
 * ADR-005 amendment 1: `type` of the pairing handoff message (`PairingCodeMessage`) that the web pairing page sends to
 * the extension over `externally_connectable` messaging after `POST /auth/extension/pair`.
 */
export const PAIRING_CODE_MESSAGE_TYPE = 'MEETOPS_PAIRING_CODE' as const;

/** Endpoint paths for the extension pairing and token lifecycle (ADR-005 amendment 1). All are POST. */
export const EXTENSION_AUTH_PATHS = {
  /** Web session (`__Host-` cookie + `x-csrf-token`) only. Issues a single-use pairing code bound to the nonce. */
  pair: '/auth/extension/pair',
  /** No cookie. Exchanges the pairing code + nonce for the first token pair. */
  token: '/auth/extension-token',
  /** No cookie, no Bearer. Authenticated by the refresh token in the body (+ extensionId/deviceId). Rotates it. */
  refresh: '/auth/extension/refresh',
  /** No cookie, no Bearer. Authenticated by the required refresh token in the body (+ extensionId/deviceId). Revokes the device's refresh family. */
  revoke: '/auth/extension/revoke',
} as const;

/**
 * Keys whose values must be redacted (replaced, never truncated) by every logger, error reporter and request/response
 * serializer (ADR-005 amendment 1). Matching is case-insensitive on the key name, at any depth.
 */
export const REDACT_KEYS = [
  'accessToken',
  'refreshToken',
  'pairingCode',
  'authorization',
  'cookie',
  'set-cookie',
  'password',
  'csrfToken',
] as const;

/**
 * Upload cap shared by direct uploads, recording sessions and the media worker: 1.4 GB (decimal, 1_400_000_000 B
 * ~= 1.30 GiB). Sized so the source plus its 16 kHz mono s16le WAV (<= ~461 MB at the 4 h duration cap) and the WAV
 * chunks (~461 MB) fit the worker's 3 GiB /tmp/work tmpfs (1.4e9 + 2 * 4.61e8 ~= 2.32e9 < 3.22e9) with headroom.
 * Single source of truth: storage, media-core callers and the worker all derive their caps from this.
 */
export const MAX_MEDIA_BYTES = 1_400_000_000;
/** Chunked recording upload: lifetime of a chunk upload URL, in seconds. */
export const CHUNK_UPLOAD_URL_TTL_SECONDS = 300;
/** 64 MiB per chunk (5 s timeslices are far smaller; this is an abuse ceiling). */
export const MAX_CHUNK_BYTES = 64 * 1024 * 1024;
/**
 * 1.4 GB (MAX_MEDIA_BYTES) per recording session. The backend MUST enforce this as a running total of the bytes signed or stored for the
 * session (on every chunk upload-URL request and again on complete), because the per-chunk limits alone cannot:
 * MAX_CHUNK_BYTES x MAX_CHUNKS is far above 1.4 GB.
 */
export const MAX_RECORDING_SESSION_BYTES = MAX_MEDIA_BYTES;
/** Upper bound on chunk count. At 5 s timeslices this is about 13.9 h. */
export const MAX_RECORDING_CHUNKS = 10_000;
/** Alias of MAX_RECORDING_CHUNKS. */
export const MAX_CHUNKS = MAX_RECORDING_CHUNKS;
/** Longest recording `durationMs` accepted by `CompleteRecordingSessionRequest`: 24 h. */
export const MAX_DURATION_MS = 24 * 60 * 60 * 1000;
