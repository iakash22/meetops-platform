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
  'PAYLOAD_TOO_LARGE',
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
 * v0.4.1 (G11): named reasons for a rejected consent attestation. Sent as `error.reason` next to
 * `code: 'VALIDATION_FAILED'` with HTTP CONSENT_HTTP_STATUS (422) by upload init and recording-session init.
 * - `CONSENT_REQUIRED`: the request has no `consent` object (or it fails the ConsentAttestationInput schema).
 * - `CONSENT_VERSION_UNSUPPORTED`: `consent.consentVersion` is not a version the server accepts (CURRENT_CONSENT_VERSION).
 * - `CONSENT_INVALID`: `consent.attestedAt` is outside the accepted window (see CONSENT_ATTESTATION_MAX_SKEW_SECONDS).
 * Nothing is created (no FileObject, no session, no presigned URL) when one of these is returned.
 */
export const CONSENT_ERROR_REASONS = [
  'CONSENT_REQUIRED',
  'CONSENT_VERSION_UNSUPPORTED',
  'CONSENT_INVALID',
] as const;
/** v0.4.1: HTTP status for every consent rejection (CONSENT_ERROR_REASONS). */
export const CONSENT_HTTP_STATUS = 422;
/**
 * v0.5.0: HTTP status for `code: 'PAYLOAD_TOO_LARGE'`. Returned when a
 * recording session's running total would exceed MAX_RECORDING_SESSION_BYTES (1.4 GB) on a chunk-URL request, or an
 * upload's `sizeBytes` exceeds MAX_UPLOAD_BYTES. No presigned URL is issued.
 */
export const PAYLOAD_TOO_LARGE_HTTP_STATUS = 413;

/**
 * Every value `ApiErrorEnvelope.error.reason` may take: CONFLICT_REASONS (with `code: 'CONFLICT'`), then
 * NOT_FOUND_REASONS (with `code: 'NOT_FOUND'`), then (v0.4.1) CONSENT_ERROR_REASONS (with `code: 'VALIDATION_FAILED'`).
 * v0.4.0 widened this from an alias of CONFLICT_REASONS.
 */
/**
 * v0.7.0: integration error reasons. INTEGRATION_NOT_CONNECTED (409): the integration is revoked or in error.
 * APPROVAL_REQUIRED (403): issue push without a matching approved WriteApproval. OAUTH_STATE_INVALID (400): callback
 * state missing, expired, consumed or mismatched. REPLAYED_DELIVERY (409): duplicate webhook delivery id (ADR-007).
 * WEBHOOK_SIGNATURE_INVALID (401).
 */
export const INTEGRATION_ERROR_REASONS = [
  'INTEGRATION_NOT_CONNECTED',
  'APPROVAL_REQUIRED',
  'OAUTH_STATE_INVALID',
  'REPLAYED_DELIVERY',
  'WEBHOOK_SIGNATURE_INVALID',
] as const;

export const API_ERROR_REASONS = [
  ...CONFLICT_REASONS,
  ...NOT_FOUND_REASONS,
  ...CONSENT_ERROR_REASONS,
  ...INTEGRATION_ERROR_REASONS,
] as const;

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

/** v0.9.0 (ADR-012, Proposed): desktop (Tauri) bearer tokens. Access TTL 15 min, refresh family capped at 30 days. */
export const DESKTOP_TOKEN_TTL_SECONDS = 900;
export const DESKTOP_REFRESH_FAMILY_MAX_LIFETIME_SECONDS = 30 * 24 * 60 * 60;
export const DESKTOP_TOKEN_AUDIENCE = 'desktop' as const;
export const DESKTOP_TOKEN_TYPE = 'Bearer' as const;
/** ADR-012 section 2.2: fixed subset. No tasks:write, approve, admin, member or integration scope. */
export const DESKTOP_SCOPES = [
  'meetings:read',
  'meetings:resolve',
  'tasks:read',
  'recordings:write',
] as const;
/** ADR-012 section 1.5: authorization codes are single-use and expire within 60 s. */
export const DESKTOP_AUTHORIZATION_CODE_TTL_SECONDS = 60;
/** Endpoint paths for the desktop sign-in and token lifecycle (ADR-012). All are POST. */
export const DESKTOP_AUTH_PATHS = {
  /** Web session (`__Host-` cookie + `x-csrf-token`) only. Issues a single-use code bound to the PKCE challenge. */
  authorize: '/auth/desktop/authorize',
  /** No cookie; ignores Authorization. Exchanges code + PKCE verifier for the first token pair. */
  token: '/auth/desktop/token',
  /** No cookie; ignores Authorization. Rotates the refresh token. */
  refresh: '/auth/desktop/refresh',
  /** No cookie; ignores Authorization. Revokes the device's refresh family. Idempotent. */
  revoke: '/auth/desktop/revoke',
  /** No cookie; ignores Authorization. Revokes the family and issues a new one for another org the user belongs to. */
  switchOrg: '/auth/desktop/switch-org',
} as const;

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
  // v0.9.0 (ADR-012 section 2.5): desktop PKCE exchange. `state` never reaches the server, and plain `code` is not
  // listed because error bodies use `code`; the desktop token body names the field `authorizationCode` instead.
  'authorizationCode',
  'codeVerifier',
  'code_verifier',
  // v0.12.0: integration secrets (provider token responses use snake_case).
  'access_token',
  'refresh_token',
  'clientSecret',
  'client_secret',
  'webhookSecret',
  'privateKey',
  'privateKeyPem',
  'apiToken',
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
/**
 * Longest recording `durationMs` accepted by `CompleteRecordingSessionRequest`: 4 h (v0.4.1, G9; was 24 h). Equals the
 * media worker's default `maxDurationSeconds` and the duration the MAX_MEDIA_BYTES tmpfs budget is sized for: a 24 h
 * 16 kHz mono WAV alone is ~2.76 GB and would not fit the 3 GiB /tmp/work.
 */
export const MAX_DURATION_MS = 4 * 60 * 60 * 1000;
/**
 * v0.4.1 (G9): longest lifetime of a presigned GET (download) URL, in seconds (5 min). The API and @meetops/storage
 * MUST NOT issue a download URL that expires later than this. Upload URLs use their own TTLs
 * (CHUNK_UPLOAD_URL_TTL_SECONDS for session chunks).
 */
export const MAX_PRESIGNED_GET_TTL_SECONDS = 300;

/**
 * v0.4.1 (G11): how the recording user attested consent before capture or upload. Extensible via a contracts PR.
 * - `all_parties_notified`: every participant was told the meeting is recorded (banner, announcement or invite text).
 * - `all_parties_consented`: every participant explicitly agreed.
 */
export const CONSENT_METHODS = ['all_parties_notified', 'all_parties_consented'] as const;
/** v0.4.1: the consent notice version clients attest to today. The API rejects other versions (CONSENT_VERSION_UNSUPPORTED). */
export const CURRENT_CONSENT_VERSION = '2026-10';
/** v0.4.1: `consentVersion` format: 1-32 chars, a letter or digit, then letters, digits, `.`, `_` or `-`. */
export const CONSENT_VERSION_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$';
/**
 * v0.4.1: the API rejects an `attestedAt` more than this many seconds ahead of its own clock (CONSENT_INVALID). The stored
 * attestation also keeps the server's receive time (`recordedAt`), so a back-dated `attestedAt` stays visible in audit.
 */
export const CONSENT_ATTESTATION_MAX_SKEW_SECONDS = 300;
/** v0.4.1: what a stored consent attestation (DB-3 `consent_attestations.subject`) is attached to. */
export const CONSENT_SUBJECT_TYPES = ['upload', 'recording_session'] as const;

/** v0.4.1 (G11): malware / content scan state of a FileObject (DB-3 `file_objects.scan_status`). */
export const FILE_OBJECT_SCAN_STATUSES = ['pending', 'clean', 'quarantined', 'rejected'] as const;

/**
 * v0.4.1 (ADR-011 section 3): Redis pub/sub channel the API publishes AuthRevocationMessage to, after the change commits.
 * Realtime nodes subscribe and disconnect matching sockets.
 */
export const AUTH_REVOCATIONS_CHANNEL = 'meetops:auth:revocations';
/** v0.4.1: AuthRevocationMessage `v`. */
export const AUTH_REVOCATION_MESSAGE_VERSION = 1;
/**
 * v0.4.1: AuthRevocationMessage `kind`: `session` (one session or extension token family), `user` (every session of
 * the user) or `membership` (every socket of the user in one organization).
 */
export const AUTH_REVOCATION_KINDS = ['session', 'user', 'membership'] as const;
/** v0.4.1: why access was revoked (ADR-011 section 3.2). */
export const AUTH_REVOCATION_REASONS = [
  'logout',
  'logout_all',
  'org_switch',
  'member_removed',
  'role_changed',
  'invitation_revoked',
  'password_changed',
  'extension_revoked',
  'desktop_revoked',
] as const;
/**
 * v0.4.1 (ADR-011 section 5): realtime re-verifies every socket at least this often (5 min). Deployments may lower it,
 * never raise it above MAX_REALTIME_REAUTH_INTERVAL_MS.
 */
export const REALTIME_REAUTH_INTERVAL_MS = 300_000;
/** v0.4.1: upper bound for a configured realtime re-auth interval. */
export const MAX_REALTIME_REAUTH_INTERVAL_MS = 300_000;
/**
 * v0.4.1: server-to-client realtime control events (ADR-011). Each is sent immediately before the server disconnects the
 * socket; the client must not retry with the same credential, except after `auth:reauth-required` (reconnect with the
 * current session).
 * - `session:revoked`: the socket's session or token family was revoked (logout, logout-all, password change, ...).
 * - `org:access-changed`: the user's membership in the socket's organization was removed or its role changed.
 * - `auth:reauth-required`: the socket must reconnect, e.g. after an org switch or a failed periodic re-verification.
 */
export const REALTIME_CONTROL_EVENTS = {
  sessionRevoked: 'session:revoked',
  orgAccessChanged: 'org:access-changed',
  authReauthRequired: 'auth:reauth-required',
} as const;
/** v0.4.1: `org:access-changed` reasons. */
export const ORG_ACCESS_CHANGE_REASONS = ['member_removed', 'role_changed'] as const;
/** v0.4.1: `auth:reauth-required` reasons. */
export const REAUTH_REASONS = ['org_switch', 'session_expired', 'revalidation_failed'] as const;

/**
 * v0.5.0: consent / retention settings.
 * - `mode`: `all_party` (every participant must consent) or `one_party` (the recording user's attestation suffices).
 */
export const CONSENT_SETTINGS_MODES = ['all_party', 'one_party'] as const;
/** v0.5.0: roles allowed to PATCH consent settings. Every role may GET them (rbac-matrix "Consent / retention settings"). */
export const CONSENT_SETTINGS_WRITE_ROLES = ['owner', 'admin'] as const;
/** v0.5.0: max length of the consent notice text shown to participants. */
export const MAX_CONSENT_NOTICE_TEXT_LENGTH = 4000;
/** v0.5.0: recording retention range in days (1 day .. 10 years). */
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;

/**
 * v0.5.0: consent settings and upload lifecycle route templates. Org-scoped; the API MUST check
 * `:organizationId` equals the session's active organization (mismatch or other-org id -> NOT_FOUND).
 * - `consentSettings`: GET (all roles) and PATCH (owner/admin, partial update, CSRF, audit-logged).
 * - `uploadComplete`: POST. Verifies size/checksum and the stored consent attestation; 422 + ConsentErrorReason and
 *   no media job enqueued when the attestation is missing or invalid.
 * - `uploadDownloadUrl`: GET. Presigned GET valid for at most MAX_PRESIGNED_GET_TTL_SECONDS (300 s).
 */
export const CONSENT_UPLOAD_PATHS = {
  consentSettings: '/orgs/:organizationId/settings/consent',
  uploads: '/orgs/:organizationId/uploads',
  uploadComplete: '/orgs/:organizationId/uploads/:fileObjectId/complete',
  uploadDownloadUrl: '/orgs/:organizationId/uploads/:fileObjectId/download-url',
} as const;

/**
 * v0.6.0: meeting route templates. Org-scoped like CONSENT_UPLOAD_PATHS (path org must be the session's active org,
 * otherwise NOT_FOUND).
 * - `meetings`: GET, `ListMeetingsQuery` -> `CursorPage<Meeting>` (every role).
 * - `meeting`: GET -> `Meeting`.
 */
export const MEETING_PATHS = {
  meetings: '/orgs/:organizationId/meetings',
  meeting: '/orgs/:organizationId/meetings/:meetingId',
} as const;

/**
 * v0.8.0: recording-session route templates (chunked capture from the extension, desktop and mobile apps). Matches the
 * API media module. Only `init` is org-scoped; the other three resolve the org from the caller's active organization.
 * - `init`: POST `InitRecordingSessionRequest` -> `InitRecordingSessionResponse`.
 * - `chunks`: POST `ChunkUploadUrlRequest` -> `ChunkUploadUrlResponse` (then PUT the bytes).
 * - `complete`: POST `CompleteRecordingSessionRequest` -> `CompleteRecordingSessionResponse`.
 * - `abort`: POST `AbortRecordingSessionRequest` -> 204.
 */
export const RECORDING_SESSION_PATHS = {
  init: '/orgs/:organizationId/recording-sessions',
  chunks: '/recording-sessions/:sessionId/chunks',
  complete: '/recording-sessions/:sessionId/complete',
  abort: '/recording-sessions/:sessionId/abort',
} as const;

/**
 * v0.8.0: meeting transcript and report reads (`MeetingInsightsParams`). Both answer 404 until the artifact exists.
 * - `transcript`: GET -> `Transcript` (latest merged revision).
 * - `report`: GET -> `Report`.
 */
export const MEETING_INSIGHTS_PATHS = {
  transcript: '/orgs/:organizationId/meetings/:meetingId/transcript',
  report: '/orgs/:organizationId/meetings/:meetingId/report',
} as const;

/**
 * v0.8.0: task route templates, matching the API tasks module.
 * - `tasks`: GET `ListTasksQuery` -> `Paginated<Task>`.
 * - `extractedTasks`: GET, extracted tasks awaiting review.
 * - `accept` / `dismiss`: POST, review one extracted task.
 * - `task`: GET -> `Task`; PATCH `UpdateTaskRequest` -> `Task` (`TaskParams`).
 */
export const TASK_PATHS = {
  tasks: '/orgs/:organizationId/tasks',
  extractedTasks: '/orgs/:organizationId/extracted-tasks',
  accept: '/orgs/:organizationId/extracted-tasks/:extractedTaskId/accept',
  dismiss: '/orgs/:organizationId/extracted-tasks/:extractedTaskId/dismiss',
  task: '/orgs/:organizationId/tasks/:taskId',
} as const;

/**
 * v0.7.0: integration route templates (ADR-007 webhooks/retries, ADR-008 OAuth state + token encryption).
 * - `integrations`: GET -> `IntegrationList` (every role; never carries tokens or secrets).
 * - `connect`: POST `ConnectIntegrationRequest` -> `ConnectIntegrationResponse` (owner/admin; session + CSRF). Issues
 *   single-use OAuth state (Jira 3LO + PKCE S256) or GitHub App install state.
 * - `callback`: GET, `IntegrationCallbackQuery`; the browser lands here from the provider. Not org-scoped in the path:
 *   the org, user and redirect come from the consumed state. Responds 303 to the web app; no JSON body.
 * - `integration`: DELETE -> 204 (owner/admin). Revokes the stored tokens and the webhook secret.
 * - `webhook`: POST, raw provider body (≤ 1 MiB); `X-Hub-Signature-256` + `X-GitHub-Delivery` for GitHub. No session.
 *   -> 202 `WebhookAcceptedResponse`; replayed delivery -> 409 `REPLAYED_DELIVERY`.
 * - `issuePush`: POST `PushTaskIssueRequest` -> 201 `IntegrationIssue` (requires an approved WriteApproval).
 */
export const INTEGRATION_PATHS = {
  integrations: '/orgs/:organizationId/integrations',
  /** v0.12.0: provider catalogue with this org's connection status. */
  providers: '/orgs/:organizationId/integrations/providers',
  connect: '/orgs/:organizationId/integrations/connect',
  callback: '/integrations/:provider/callback',
  integration: '/orgs/:organizationId/integrations/:integrationId',
  webhook: '/webhooks/:provider/:integrationId',
  /** v0.12.0: App-wide GitHub webhook (a GitHub App has one webhook URL); routed by payload.installation.id. */
  githubAppWebhook: '/webhooks/github',
  issuePush: '/orgs/:organizationId/tasks/:taskId/integration-issues',
} as const;

/** v0.7.0: integration connection lifecycle (Prisma `IntegrationStatus`). */
export const INTEGRATION_STATUSES = ['active', 'error', 'revoked'] as const;
/** v0.12.0: per-provider connection state for the web integrations page (`not_connected` = no row). */
export const INTEGRATION_CONNECTION_STATES = ['not_connected', ...INTEGRATION_STATUSES] as const;
/** v0.7.0: OAuth/App-install state TTL bounds in seconds (ADR-008: default 600, clamped 60-900). */
export const INTEGRATION_STATE_TTL_SECONDS = 600;
/** v0.7.0: webhook body cap in bytes (ADR-007). */
export const INTEGRATION_WEBHOOK_MAX_BYTES = 1_048_576;
