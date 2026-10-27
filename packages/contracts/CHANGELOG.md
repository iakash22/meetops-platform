# Changelog

All notable changes to `@meetops/contracts` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package uses [Semantic Versioning](https://semver.org/).
While the version is `0.x`, a minor bump may contain breaking changes (ADR-003).

## [Unreleased]

### Changed

- Upload `filename` (`CreateUploadRequest` and `InitUploadRequest`) now also rejects C0 control characters (CR, LF, tab
  and the rest), DEL and bidi embedding/override/isolate characters (U+202A-U+202E, U+2066-U+2069), as well as `/`,
  `\` and NUL (security review B 4.3).
- Upload `filename` additionally rejects C1 controls, line/paragraph separators and every BMP format (Cf) character:
  zero-width space/joiners and LRM/RLM (U+200B-U+200F), U+2060-U+2064, U+206A-U+206F, U+FEFF, U+00AD, U+061C, U+180E,
  U+FFF9-U+FFFB and the rest (`FILENAME_PATTERN`, #270 L-1). New `isSafeUploadFilename()` also rejects astral
  Cc/Cf/Co/Cs code points (e.g. tag characters); the API enforces it.

## [0.11.0] - 2026-10-28

Notifications (ADR-013, Accepted). Additive; builds on 0.10.0 (re-versioned from 0.10.0, which PR #261 uses for tasks).

### Added

- `NOTIFICATION_PATHS`: feed list, mark one read (`/notifications/:notificationId/read`), mark all read
  (`/notifications/read-all`), preferences (GET/PUT), push device register/unregister (`/me/push-devices`, `/me/push-devices/:id`; mobile PR #262), unsubscribe
  (GET confirm page, POST applies).
- DTOs: `Notification` (`id`, `organizationId`, `kind`, `title`, optional `body`/`meetingId`/`taskId`, nullable
  `readAt`, `createdAt`; web PR #260), `NotificationList` (`items`, keyset `nextCursor`), `ListNotificationsQuery`,
  `NotificationParams`, `MarkNotificationsReadResponse` (`updated`), `NotificationPreference(s)`,
  `UpdateNotificationPreferencesRequest`, `RegisterPushDeviceRequest` (`{provider:'expo', token, platform:'ios'|'android',
deviceName?}` or `{provider:'webpush', subscription, platform:'web'|'extension', deviceName?}`), `PushDevice`
  (`{id, platform, createdAt}`), `PushDeviceParams` (`{id}`), `UnsubscribeQuery`/`Response`.
- `NOTIFICATION_CHANNELS`, `PUSH_PLATFORMS`, `WEB_PUSH_ALLOWED_HOSTS`, `EXPO_PUSH_TOKEN_PATTERN`, `EXPO_PUSH_API_URL`,
  `GENERIC_PUSH_TITLE`/`GENERIC_PUSH_BODY`.
- Jobs: `NOTIFICATION_DELIVERY_QUEUE`, `NOTIFICATION_DELIVERY_JOB_RETENTION`, `NotificationDeliveryJobPayload`
  (mandatory `organizationId`).
- `REDACT_KEYS`: `expoPushToken`, `p256dh`, `auth` (Web Push subscription secret).

## [0.10.0] - 2026-10-27

Task write bodies; additive, builds on 0.9.0.

### Added

- `CreateTaskRequest`: body of POST `TASK_PATHS.tasks` (manual task; status/priority default server-side to
  `todo`/`medium`; unknown keys rejected).
- `AcceptExtractedTaskRequest`: body of POST `TASK_PATHS.accept` (matches the API's former `AcceptExtractedTaskBody`).

## [0.9.0] - 2026-10-27

Desktop (Tauri) sign-in schemas for ADR-012 Option A (system browser, authorization code + PKCE S256, loopback
redirect). ADR-012 is still Proposed; additive, builds on 0.8.0.

### Added

- `DESKTOP_TOKEN_AUDIENCE`, `DESKTOP_TOKEN_TYPE`, `DESKTOP_SCOPES` (`meetings:read`, `meetings:resolve`, `tasks:read`,
  `recordings:write`), `DESKTOP_TOKEN_TTL_SECONDS` (900), `DESKTOP_REFRESH_FAMILY_MAX_LIFETIME_SECONDS` (30 days),
  `DESKTOP_AUTHORIZATION_CODE_TTL_SECONDS` (60) and `DESKTOP_AUTH_PATHS`.
- Strict `Desktop{Authorize,Token,Refresh,Revoke,SwitchOrg}{Request,Response}`, `PkceCodeChallenge`,
  `PkceCodeVerifier`, `DesktopRedirectUri` (`http://127.0.0.1:<1024-65535>/callback` only).
- `desktop_revoked` in `AUTH_REVOCATION_REASONS`.
- `REDACT_KEYS`: `authorizationCode`, `codeVerifier`, `code_verifier`.

### Changed

- The token body field is `authorizationCode`, not ADR-012's `code`: `code` is the error-body key, so redacting it
  everywhere would hide error codes in logs. `state` stays client-only and never reaches the server.

## [0.8.0] - 2026-10-27

Route constants and the task update DTO, so the API and the web, desktop, mobile and extension apps can drop their
pinned local copies. Additive; builds on 0.7.0.

### Added

- `UpdateTaskRequest` (PATCH `TASK_PATHS.task`): partial task update; `null` clears `description`, `assigneeId` and
  `dueAt`; at least one key; unknown keys rejected. Matches the API's `UpdateTaskBody` (feat/task-approval-api).
  `TaskParams` for the single-task routes.
- `TASK_PATHS`: `tasks`, `extractedTasks`, `accept`, `dismiss`, `task` (same templates as the API tasks module).
- `RECORDING_SESSION_PATHS`: `init`, `chunks`, `complete`, `abort`, plus `InitRecordingSessionParams` and
  `RecordingSessionParams`.
- `MEETING_INSIGHTS_PATHS`: `transcript`, `report`, plus `MeetingInsightsParams`, `MeetingTranscriptResponse`
  (`Transcript`) and `MeetingReportResponse` (`Report`).
- `EMAIL_TEMPLATE_IDS` / `EmailJobPayload` (user recipient): `member-added`, `member-removed`, `tasks-ready-for-review`, `integration-error` (product mails; ids-only payloads, variables resolved by the worker).

## [0.7.0] - 2026-10-26

Integration routes (Phase 5), following ADR-007 (retries, webhook replay) and ADR-008 (OAuth state + PKCE, token
encryption at rest). Builds on 0.6.1.

### Added

- `User.emailVerifiedAt` (optional, nullable ISO date-time), returned by `GET /auth/session`; used by web PR #188 (verification banner).

- `INTEGRATION_PATHS`: list, connect, OAuth/App-install callback, disconnect, webhook, and task issue push.
- DTOs: `Integration` (never carries tokens, webhook secret or ciphertext), `IntegrationList`, `IntegrationParams`,
  `ConnectIntegrationRequest`/`Response`, `IntegrationCallbackQuery`/`Params`, `WebhookParams`,
  `WebhookAcceptedResponse`, `PushTaskIssueRequest`/`Params`. `IntegrationStatus` (`INTEGRATION_STATUSES`).
- `INTEGRATION_STATE_TTL_SECONDS` (600) and `INTEGRATION_WEBHOOK_MAX_BYTES` (1 MiB).

### Changed (breaking)

- `API_ERROR_REASONS` / `ApiErrorReason` gain `INTEGRATION_ERROR_REASONS`: `INTEGRATION_NOT_CONNECTED`,
  `APPROVAL_REQUIRED`, `OAUTH_STATE_INVALID`, `REPLAYED_DELIVERY`, `WEBHOOK_SIGNATURE_INVALID`. Additive on the wire;
  exhaustive switches over `ApiErrorReason` must add them (ADR-003 §5). None exists in the repo today.

## [0.6.1] - 2026-10-26

### Fixed

- `ListTasksQuery` no longer puts a `default` on `limit` inside its `anyOf` variants. Fastify's Ajv strict mode
  refuses to compile a `default` inside `anyOf`, so servers had to strip it. Accepted and rejected inputs are
  unchanged; servers apply `DEFAULT_PAGE_LIMIT` when `limit` is absent (Value.Default no longer fills it).

## [0.6.0] - 2026-10-26

Native capture sources and the meetings list route. Builds on 0.5.0 (#168). Needed by mobile PR #173, desktop PRs
#176 and #180. A `0.x` minor that contains a breaking change (ADR-003).

### Changed (breaking)

- `RecordingSource` gains `'mobile'` and `'desktop'` (was `'tab'` only), used in `InitRecordingSessionRequest.source`.
  Accepting more request values is additive for servers, but code that switches exhaustively over `RecordingSource`
  must add the new members (ADR-003 §5). None exists in the repo today. Persisting the value also needs the
  `RecordingSource` Postgres enum (currently `tab` only) to gain `mobile` and `desktop`: a database migration,
  tracked separately from this contracts release.

### Added

- `User.emailVerifiedAt` (optional, nullable ISO date-time), returned by `GET /auth/session`; used by web PR #188 (verification banner).

- `ListMeetingsQuery` and `ListMeetingsParams` for `GET /orgs/:organizationId/meetings`, returning
  `CursorPage<Meeting>`. Paged like `ListTasksQuery` (`cursor` + `limit`), newest first, with optional `status`
  (single or array), `source`, `projectId`, `startedAfter`, `startedBefore` and `q` filters. Unknown params are rejected.
- `MEETING_PATHS` route templates (`meetings`, `meeting`).

## [0.5.0] - 2026-10-26

Consent settings, upload complete / download-URL contracts and the `PAYLOAD_TOO_LARGE` (413) error code. Builds on
0.4.1 (#156). A `0.x` minor that contains a breaking change (ADR-003).

### Changed (breaking)

- `ApiErrorCode` / `API_ERROR_CODES` gain `PAYLOAD_TOO_LARGE`. Adding a member to a response union breaks exhaustive
  consumers (ADR-003 §5): every `Record<ApiErrorCode, …>` map must add an entry. Affected consumers, updated in this
  release: `apps/web/src/lib/api/error-messages.ts`, `apps/web/src/features/extension/pair-errors.ts`,
  `apps/web/src/features/desktop/authorize-errors.ts`. No other exhaustive map exists (apps/api, desktop, extension,
  mobile, realtime, worker use non-exhaustive status maps that fall back to `BAD_REQUEST` / `INTERNAL` for 413).

### Added

- `User.emailVerifiedAt` (optional, nullable ISO date-time), returned by `GET /auth/session`; used by web PR #188 (verification banner).

- `api/consent-settings.ts`: `ConsentSettings` (`{ mode, noticeText, skipExternalParticipants, retentionDays,
currentConsentVersion, updatedAt }`), `UpdateConsentSettingsRequest` (partial, strict, non-empty; server-owned
  fields not writable), `ConsentSettingsMode` (`all_party | one_party`).
- `api/uploads.ts`: `CompleteUploadRequest` (empty strict), `CompleteUploadResponse` (`{ fileObject, scanStatus }`),
  `UPLOAD_COMPLETE_CONSENT_ERROR_REASONS`, `DownloadUrlResponse` (`{ url, method: 'GET', expiresIn <= 300, expiresAt }`).
- Constants: `CONSENT_UPLOAD_PATHS`, `CONSENT_SETTINGS_MODES`, `CONSENT_SETTINGS_WRITE_ROLES` (owner, admin),
  `MAX_CONSENT_NOTICE_TEXT_LENGTH` (4000), `MIN_RETENTION_DAYS` (1), `MAX_RETENTION_DAYS` (3650).
- Error code `PAYLOAD_TOO_LARGE` in `ApiErrorCode` / `API_ERROR_CODES`, with
  `PAYLOAD_TOO_LARGE_HTTP_STATUS` (413) and type `PayloadTooLargeErrorEnvelope`: a recording session's running total
  over `MAX_RECORDING_SESSION_BYTES` (1.4 GB) or an upload `sizeBytes` over `MAX_UPLOAD_BYTES`.

## [0.4.1] - 2026-10-25

Consent attestation (G11), FileObject scan status, realtime auth-revocation contracts (G2, ADR-011) and the G9 upload
limits. A `0.x` patch that contains breaking changes (ADR-003); see "Changed (breaking)".

### Added

- `User.emailVerifiedAt` (optional, nullable ISO date-time), returned by `GET /auth/session`; used by web PR #188 (verification banner).

- `api/consent.ts`: `ConsentAttestationInput` (`{ consentVersion, attestedAt, method }`, strict: a client cannot send
  `attestedByUserId` or `organizationId`), the stored `ConsentAttestation` record (server-filled `attestedByUserId`,
  `organizationId`, `subjectType`, `subjectId`, `recordedAt`), `ConsentMethod`, `ConsentVersion`, `ConsentSubjectType`,
  `ConsentErrorReason`.
- Constants: `CONSENT_METHODS` (`all_parties_notified`, `all_parties_consented`), `CURRENT_CONSENT_VERSION`,
  `CONSENT_VERSION_PATTERN`, `CONSENT_ATTESTATION_MAX_SKEW_SECONDS` (300), `CONSENT_SUBJECT_TYPES`,
  `CONSENT_ERROR_REASONS` (`CONSENT_REQUIRED`, `CONSENT_VERSION_UNSUPPORTED`, `CONSENT_INVALID`, with
  `code: 'VALIDATION_FAILED'`), `CONSENT_HTTP_STATUS` (422); the reasons are part of `API_ERROR_REASONS` /
  `ApiErrorReason`. Type `ConsentErrorEnvelope`.
- `api/uploads.ts`: `InitUploadRequest` (the upload body plus a required `consent`) and `InitUploadResponse` (alias of
  `CreateUploadResponse`).
- `domain/media.ts`: `FileObjectScanStatus` (`pending | clean | quarantined | rejected`), `FILE_OBJECT_SCAN_STATUSES`,
  and optional `FileObject.scanStatus`.
- `realtime`: `AuthRevocationMessage` (ADR-011 section 3; ids-only, strict, `v: 1`, `kind: session | user | membership`)
  with `AuthRevocationReason` / `AuthRevocationKind`, `AUTH_REVOCATIONS_CHANNEL` (`meetops:auth:revocations`),
  `AUTH_REVOCATION_MESSAGE_VERSION`, `AUTH_REVOCATION_KINDS`, `AUTH_REVOCATION_REASONS` (logout, logout_all, org_switch,
  member_removed, role_changed, invitation_revoked, password_changed, extension_revoked).
- `realtime` control events, kept separate from the domain events (`REALTIME_EVENTS` is unchanged):
  `REALTIME_CONTROL_EVENTS`, `SessionRevokedEvent` (`session:revoked`), `OrgAccessChangedEvent` (`org:access-changed`,
  `role` only for `role_changed`), `AuthReauthRequiredEvent` (`auth:reauth-required`, G2), `RealtimeControlEvent`,
  `RealtimeControlEventSchemas`, `RealtimeControlEventMap`, `ORG_ACCESS_CHANGE_REASONS`, `REAUTH_REASONS`,
  `REALTIME_REAUTH_INTERVAL_MS` / `MAX_REALTIME_REAUTH_INTERVAL_MS` (300 s). `ServerToClientEvents` now also includes
  the control events (additive).
- `MAX_PRESIGNED_GET_TTL_SECONDS` (300, G9).

### Changed (breaking)

- `InitRecordingSessionRequest` requires `consent: ConsentAttestationInput`. The API answers 422 `CONSENT_REQUIRED`
  without it.
- `POST /orgs/:organizationId/uploads` is validated with `InitUploadRequest`, so a body without `consent` is rejected
  with 422 `CONSENT_REQUIRED`.
- `MAX_DURATION_MS` is 4 h (was 24 h), matching the worker default and the tmpfs budget (G9). Media limits stay at
  1.4 GB (2 GB rejected), 10_000 chunks and a 300 s chunk PUT TTL. Decision recorded in
  `docs/12-security/upload-media-security.md` section 1.

### Deprecated

- `CreateUploadRequest`: the v0.4.0 body without `consent`. Kept only so existing clients compile; use
  `InitUploadRequest`. Removal in 0.5.0.

## [0.4.0] - 2026-10-25

Directory contracts (employees, teams + team members, projects). A `0.x` minor bump (ADR-003): it also releases the
breaking upload-limit changes listed under "Changed (breaking)" below, which were unreleased in 0.3.3.

### Added

- `User.emailVerifiedAt` (optional, nullable ISO date-time), returned by `GET /auth/session`; used by web PR #188 (verification banner).

- `api/employees.ts`: `EmployeeDto`, `CreateEmployeeRequest`, `UpdateEmployeeRequest`, `ListEmployeesQuery`,
  `ListEmployeesResponse`, `EmployeesParams`, `EmployeeParams` (+ `EmployeeName`, `EmployeeField`, `EmployeeEmail`).
  `EmployeeDto.email` follows the UserSummary RBAC rule (owner/admin only).
- `api/teams.ts`: `TeamDto`, `CreateTeamRequest`, `UpdateTeamRequest`, `ListTeamsQuery`, `ListTeamsResponse`,
  `TeamsParams`, `TeamParams`; team members `TeamMemberDto`, `TeamMemberRole` (`lead | member`), `AddTeamMemberRequest`,
  `UpdateTeamMemberRequest`, `ListTeamMembersQuery`, `ListTeamMembersResponse`, `TeamMemberParams`; shared
  `DirectoryKey` and `DirectoryDescription`.
- `api/projects.ts`: `ProjectDto` (strict, with `key`, `status`, `teamId`), `ProjectStatus`, `CreateProjectRequest`,
  `UpdateProjectRequest` (key is immutable), `ListProjectsQuery`, `ListProjectsResponse`, `ProjectsParams`, `ProjectParams`.
- List routes use cursor pagination (`CursorPageQuery` / `CursorPage`); employee/team/project DELETE is a soft delete
  returning 204 (see the `DIRECTORY_PATHS` doc comment). Every request and response schema is `additionalProperties: false`, every id is a UUID, and names use
  `SafeDisplayText` (1-200, trimmed, shared unsafe-character rules).
- `common.ts`: `SafeMultilineText`, `SAFE_MULTILINE_TEXT_PATTERN`, `UNSAFE_MULTILINE_TEXT_CHARS` for descriptions
  (allows tab/LF/CR and prose punctuation; rejects other control, bidi/invisible and tag characters).
- Constants (also in `/types`): `DIRECTORY_PATHS` (all under `/orgs/:organizationId/...`), `PROJECT_STATUSES`,
  `TEAM_MEMBER_ROLES`, `DIRECTORY_KEY_PATTERN`, `MAX_DIRECTORY_NAME_LENGTH`, `MAX_DIRECTORY_DESCRIPTION_LENGTH`,
  `MAX_EMPLOYEE_FIELD_LENGTH`, `MAX_EMAIL_LENGTH`.
- Errors: `CONFLICT_REASONS` gains `PROJECT_KEY_TAKEN` and `TEAM_MEMBER_EXISTS`. New `NOT_FOUND_REASONS`
  (`EMPLOYEE_NOT_FOUND`, `TEAM_NOT_FOUND`, `PROJECT_NOT_FOUND`), `NotFoundReason`, `NOT_FOUND_HTTP_STATUS` (404),
  `NotFoundErrorEnvelope` and `DIRECTORY_ERROR_REASONS`. They travel as `error.reason` next to the unchanged generic
  `code` (`NOT_FOUND` / `CONFLICT`), so the tenancy rule (other-org ids are NOT_FOUND, never FORBIDDEN) is kept: the API
  MUST send the same body for a missing, soft-deleted or other-org id.

### Changed

- `API_ERROR_REASONS` / `ApiErrorReason` are now `[...CONFLICT_REASONS, ...NOT_FOUND_REASONS]` (no longer aliases of
  `CONFLICT_REASONS` / `ConflictReason`). `ApiErrorEnvelope.error.reason` accepts either kind. Exhaustive
  `Record<ApiErrorReason, …>` maps need the new keys (none exist in the repo today).
- The loose domain `Project` schema is kept for existing web mocks; directory routes return `ProjectDto`.
- The deprecated `PresignedUrl` / `StorageObjectMetadata` re-exports are kept: their removal is deferred until
  `@meetops/storage` stops importing them.

### Changed (breaking)

- `MAX_MEDIA_BYTES` (and so `MAX_UPLOAD_BYTES`, `MAX_RECORDING_SESSION_BYTES`) lowered from 2,000,000,000 to
  1,400,000,000 bytes (1.4 GB decimal) so source + normalized WAV fit the media worker's 3 GiB tmpfs.
- `CreateUploadRequest.checksumSha256` is now REQUIRED: standard base64 sha256 of the file (`Sha256Base64`).
- `ChunkUploadUrlRequest.sha256` (lowercase hex) is now REQUIRED; the signed PUT always carries `x-amz-checksum-sha256`.

### Notes

- Presigned uploads are single-use server-side: the URL carries signed `x-amz-meta-upload-token` and `if-none-match: *`
  headers that clients must send verbatim from `upload.headers` / `upload.fields`.

## [0.3.3] - 2026-10-24

All changes are additive. No export was removed and no existing schema got stricter.

### Added

- `User.emailVerifiedAt` (optional, nullable ISO date-time), returned by `GET /auth/session`; used by web PR #188 (verification banner).

- Errors: `CONFLICT_REASONS` (`ALREADY_MEMBER`, `INVITATION_EXPIRED`, `INVITATION_REVOKED`,
  `INVITATION_ALREADY_ACCEPTED`, `LAST_OWNER`), the `ConflictReason` schema/type and `CONFLICT_HTTP_STATUS` (409).
  `ApiErrorEnvelope.error.reason` is an optional `ConflictReason`, sent only with `code: 'CONFLICT'`.
  `ConflictErrorEnvelope` is the 409 body type with `reason` required. Matches the 409 paths of the API in #53
  (invite/accept for an active member, expired/revoked/already-accepted invitation, last owner), plus `EMAIL_TAKEN`
  and the generic `CONFLICT` fallback: the API sets `reason` on every 409. `API_ERROR_REASONS` / `ApiErrorReason`
  are aliases of `CONFLICT_REASONS` / `ConflictReason`.
- Pagination: `DEFAULT_PAGE_LIMIT` (25, the `CursorPageQuery.limit` default).
- Package exports: `./types` also has a `default` condition (same ESM file), so `require()`, Jest and Metro
  (React Native) resolve the light entry. `.` and `./legacy` are unchanged.

### Changed

- API behaviour documented by this release: removing or demoting the last owner of an organization is
  `409 CONFLICT` with `reason: 'LAST_OWNER'` (was 422).
- `MAX_PAGE_LIMIT` and `MAX_CURSOR_LENGTH` now live in `constants.ts`, so the light `@meetops/contracts/types`
  entry exports them (and the new conflict constants). They are still exported from the main entry with the same
  values. The cursor page shape (`CursorPage`, `ListOrganizationsResponse`, `ListMembersResponse`) is unchanged.

## [0.3.2] - 2026-10-22

Security's LOW follow-up from #59. Validation is stricter; no exports were removed.

### Changed

- `UNSAFE_DISPLAY_TEXT_CHARS` (and so `deviceLabel`, `CreateOrganizationRequest.name` and `organizationName`) also
  rejects U+00AD (soft hyphen), U+180E, U+3164 (Hangul filler), U+FE00-U+FE0F (variation selectors) and the tag
  characters U+E0000-U+E007F (new `UNSAFE_DISPLAY_TEXT_TAGS`). The patterns work both without the `u` flag (TypeBox
  `Value.Check`) and with it (Ajv in Fastify).
- `ExtensionPairResponse.organizationName` uses `SafeDisplayText` with the same bounds as the org name (1–200, no
  leading or trailing whitespace).
- `MAX_RECORDING_SESSION_BYTES` (2 GB) JSDoc: the backend MUST enforce it as a running total per session. The
  per-chunk limits cannot enforce it.

## [0.3.1] - 2026-10-22

All changes in this release are additive. No existing export changed.

### Added

- `User.emailVerifiedAt` (optional, nullable ISO date-time), returned by `GET /auth/session`; used by web PR #188 (verification banner).

- Organizations: `CreateOrganizationRequest { name (1–200) }` and `CreateOrganizationResponse` (an alias of the new
  `OrganizationWithRole { organization: Organization, role: Role }`) for `POST /orgs` (201). The server derives `slug`, and
  the caller becomes `owner`.
- `ListOrganizationsResponse { items: OrganizationWithRole[], nextCursor: string | null }` for `GET /orgs` (a cursor page,
  built from `CursorPage`). It is not a bare `Organization[]`.
- Sessions: `SessionSummary { id, current, createdAt, lastSeenAt, expiresAt, ip: string (≤45) | null, userAgent: string (≤1024) | null }`
  and `ListSessionsResponse` (cursor page) for `GET /auth/sessions`, plus `SessionIdParams { sessionId }` for
  `DELETE /auth/sessions/:sessionId`. `SessionSummary` never carries token, hash or other secret fields, and because it is
  strict, a serializer that adds one fails validation.
- Members: `UserSummary { id, email, name?, avatarUrl? }`, `OrganizationMember { id, organizationId, userId, role,
createdAt, user: UserSummary }` and `ListMembersResponse` (cursor page) for `GET /orgs/:organizationId/members`.
- All of these are strict (`additionalProperties: false`) and are exported from the main entry. Their types are exported
  from `@meetops/contracts/types`.
- Chunk limits moved to `constants.ts`, so they are also exported from `@meetops/contracts/types` (no TypeBox):
  `MAX_CHUNK_BYTES`, `MAX_CHUNKS` / `MAX_RECORDING_CHUNKS`, `MAX_RECORDING_SESSION_BYTES`, `MAX_MEDIA_BYTES`,
  `CHUNK_UPLOAD_URL_TTL_SECONDS`, and the new `MAX_DURATION_MS` (24 h, the `durationMs` cap of
  `CompleteRecordingSessionRequest`). The main entry still exports them with the same values. `apps/extension` can drop
  its local `MAX_DURATION_MS` and the four mirrors in `src/lib/contract-limits.ts` (PR #60).
- Pairing handoff (ADR-005 A1): `PairingCodeMessage { type: 'MEETOPS_PAIRING_CODE', pairingCode, nonce }` (strict, no
  tokens), plus `PAIRING_CODE_MESSAGE_TYPE` in `constants.ts`. `ExtensionPairingCode` (32–128 base64url) is now exported.

### Changed

- `CreateOrganizationRequest.name` uses the same charset as `deviceLabel`, via the new shared `SafeDisplayText` helper
  (with `SAFE_DISPLAY_TEXT_PATTERN`, `SAFE_DISPLAY_TEXT_TRIMMED_PATTERN` and `UNSAFE_DISPLAY_TEXT_CHARS`). It also rejects
  whitespace-only names and leading or trailing whitespace. A schema cannot trim, so clients MUST trim before sending.
  Names with `'`, `&`, `<`, `>` or `"` are now rejected.
- `Organization` is strict (`additionalProperties: false`). Responses that add fields to it fail validation.
- `CursorPage` (and so `Paginated` and every list response) caps `items` at `MAX_PAGE_LIMIT` (100, the same as the
  query `limit` maximum) and `nextCursor` at `MAX_CURSOR_LENGTH` (512).
- `UserSummary.avatarUrl` (`HttpsAvatarUrl`) must be https with no userinfo: no `@`, `\` or whitespace in the authority,
  and no `\` or whitespace in the path. Max length 2048.
- `UserSummary.email` is optional. The API MUST include it only for `owner` and `admin` viewers, and MUST omit it for
  `member` and `viewer` viewers.
- `deviceLabel` (`ExtensionDeviceLabel`) also rejects the invisible format characters U+200B-U+200D (zero-width space,
  non-joiner, joiner), U+2060 (word joiner), U+FEFF (BOM / zero-width no-break space) and U+061C (Arabic letter mark).

## [0.3.0] - 2026-10-22

### Added

- `User.emailVerifiedAt` (optional, nullable ISO date-time), returned by `GET /auth/session`; used by web PR #188 (verification banner).

- Meetings: `ResolveMeetingRequest` (a strict union; at least one of `externalMeetingUrl` (https) or `externalMeetingId`
  (opaque, ≤255) is required) and `ResolveMeetingResponse { meetingId, created }`, for
  `POST /orgs/:organizationId/meetings/resolve`. It is idempotent per (organizationId, source, externalMeetingId).
  Also adds `GetMeetingParams { organizationId, meetingId }`.
- Extension auth (ADR-005 + amendment 1, pairing proof): `ExtensionPairRequest { extensionId, deviceId (UUID), nonce
(32–128 base64url), deviceLabel? (printable, ≤100) }` → `ExtensionPairResponse { pairingCode, expiresAt, organizationId,
organizationName }` (no tokens); `ExtensionTokenRequest { extensionId, deviceId, pairingCode, nonce }` →
  `ExtensionTokenResponse` (strict: `accessToken`, `refreshToken`, `tokenType: 'Bearer'`, `audience: 'extension'`,
  `expiresAt`, `expiresIn` ≤900, `refreshExpiresAt`, `organizationId`, `scopes` (1–2, unique), `nonce` echo);
  `ExtensionRefreshRequest`/`ExtensionRefreshResponse` (rotation); `ExtensionRevokeRequest`/`ExtensionRevokeResponse`.
  `ExtensionRevokeRequest.refreshToken` is **required**: refresh and revoke are authenticated by the refresh token in the
  body (bound to `extensionId` and `deviceId`), not by Bearer, so both work after the access token has expired.
  `deviceLabel` also rejects `<`, `>`, `"`, `'`, `&` and bidi/format characters (U+200E-U+200F, U+202A-U+202E, U+2066-U+2069).
  Constants: `EXTENSION_AUTH_PATHS`, `EXTENSION_SCOPES`, `EXTENSION_TOKEN_AUDIENCE`, `EXTENSION_TOKEN_TYPE`,
  `EXTENSION_TOKEN_TTL_SECONDS` (900), `EXTENSION_REFRESH_FAMILY_MAX_LIFETIME_SECONDS` (30 days), and `REDACT_KEYS`
  (includes `accessToken`, `refreshToken`) for loggers. These two token responses are the **only** API bodies that carry tokens.
- Auth: `SwitchOrganizationRequest` for `POST /auth/switch-org`. It returns `AuthSession` with a rotated csrfToken, and the
  session id is rotated.
- Errors: `CSRF_INVALID`.
- Tasks: `ListTasksQuery` (strict; cursor pagination plus status (one or several), priority, assigneeId, projectId,
  meetingId, dueBefore, dueAfter, q ≤200, and `unassigned: true` (literal; a strict union makes it mutually exclusive with
  assigneeId)), `TASK_STATUSES` and the `TaskStatusValue` alias.

- Light entry `@meetops/contracts/types`: types only plus plain constants (`TASK_STATUSES`, `ROLES`, `API_ERROR_CODES`,
  `EXTENSION_*`, `EXTENSION_AUTH_PATHS`, `REDACT_KEYS`), with zero runtime TypeBox import. It is recommended for `apps/extension`. For a
  constants-only import, esbuild measures ≈47.5 kB minified (12.5 kB gzip) through the main entry versus ≈0.15 kB through the light entry.
- `package.json`: `"sideEffects": false`.

### Changed

- `Transcript.provider` is now `TranscriptProviderId` (`SttProviderId` values plus `'unknown'`). `'unknown'` is for legacy rows
  backfilled by the DB migration only; new transcripts MUST record a real provider. `SttProviderId` (routing) is unchanged and
  rejects `'unknown'`. Adds `STT_PROVIDER_IDS` and `TRANSCRIPT_PROVIDER_IDS` constants (also in `/types`).
- `TASK_STATUSES` and `ROLES` now live in `src/constants.ts` (with the extension constants) and are re-exported unchanged from
  the main entry.
- `PresignedUrlString` rejects userinfo (`user@`, `user:pass@`) for both https and http URLs.

### Confirmed (DB alignment, ADR-004 addendum 2)

- `organizationId` is canonical (the DB column is `org_id` via `@map`). `ExtractedTask.reportId` and `Transcript.provider` are
  required. The only link between Task and ExtractedTask is `Task.extractedTaskId`; there is no `acceptedTaskId`. There is no
  `employeeId` on participants. No schema changes were needed; tests now guard these.

### Deprecated

- `PresignedUrl` and `StorageObjectMetadata` are deprecated in 0.3.0. They are still re-exported from the main entry point
  (as `@deprecated` types), because `@meetops/storage` still depends on them, and from `@meetops/contracts/legacy`.
  Removal is scheduled for 0.4.0. Replacements: `PresignedUrlDto` for `PresignedUrl`; `PublicFileObject` (client-facing)
  or the internal `FileObject` for `StorageObjectMetadata`.

## [0.2.0] - 2026-10-21

### Added

- `User.emailVerifiedAt` (optional, nullable ISO date-time), returned by `GET /auth/session`; used by web PR #188 (verification banner).

- Auth: `GetAuthSessionResponse` (alias `GetAuthSession`), `CsrfResponse`, `ResetPasswordRequest`, `VerifyEmailRequest`.
- Uploads: `CreateUploadRequest`, `CreateUploadResponse`, `PresignedUrlDto`, `PublicFileObject`, `MAX_UPLOAD_BYTES`.
- Chunked recording sessions: `InitRecordingSessionRequest/Response`, `ChunkUploadUrlRequest/Response`,
  `CompleteRecordingSessionRequest/Response`, `AbortRecordingSessionRequest`, `RecordingSource`, `AbortReason`, and the
  `CHUNK_UPLOAD_URL_TTL_SECONDS`, `MAX_CHUNK_BYTES`, `MAX_RECORDING_SESSION_BYTES` and `MAX_RECORDING_CHUNKS` constants.
- Realtime: `MeetingStatusEvent`, `TranscriptionProgressEvent`, `TaskUpdateEvent`, `RealtimeEvent` union,
  `REALTIME_EVENTS`, `RealtimeEventSchemas`, `RealtimeEventMap`, `ServerToClientEvents`.
- Domain: `MeetingParticipant`, `ReportContent` and `ReportActionItem`, `Task.extractedTaskId`,
  `Transcript.provider` and `providerJobId`, `TranscriptSegment.id`.
- Static types for `MeetingSource`, `TaskStatus`, `TaskPriority`.
- `AUTH_FAILED` error code.
- Email: `EMAIL_QUEUE` (`'email'`), `EMAIL_JOB_RETENTION` (removeOnComplete `{count:100, age:3600}`, removeOnFail
  `{count:500, age:86400}`), `EMAIL_TEMPLATE_IDS` / `EmailTemplateId` (`verification`, `password-reset`, `invitation`,
  `task-assigned`, `meeting-summary`), `EmailRecipientRef`, `OPAQUE_ID_PATTERN`, and the advisory
  `EMAIL_TEMPLATE_RECIPIENT` / `expectedRecipientKind()` (invitation→invitationId, others→userId).
- `WriteApproval { approvalId, organizationId, approverUserId, payloadHash (sha256 hex), approvedAt? }`.
- Media limits: `MAX_MEDIA_BYTES` (2,000,000,000 bytes), `ALLOWED_MEDIA_MIME_TYPES` and the `MediaMimeType` schema.
- `@meetops/contracts/legacy` subpath export.

### Changed

- `AbortRecordingSessionRequest.reason` adds `local_storage_exhausted`.

- `IntegrationIssue` (alias `IntegrationIssueRecord`) is tenant-scoped: adds `organizationId`, `integrationId`, `provider` (`github`|`jira`, replaces free-form `integration`), optional `lastKnownStatus`; strict. Unique on (organizationId, provider, externalId). (BREAKING)

- All `Id`s are `format: uuid`.
- `AuthSession`: `accessToken` removed (the session is an `__Host-` HttpOnly cookie). Added `csrfToken`,
  `activeOrganizationId` and `role`.
- Passwords must be 12–128 characters. Request schemas reject unknown properties.
- `EmailJobPayload` now matches the Integrations shape (PR #11, queue `email`): `{ jobVersion: 1, kind: 'send_email', organizationId,
idempotencyKey (opaque `^[A-Za-z0-9_-]+$`, 1–200), requestId?, templateId, recipient: {userId} | {invitationId},
refs? (≤10 opaque id pairs), locale? (BCP-47-ish, ≤35) }`. Every level rejects extra properties, and the payload carries no addresses,
  variables, URLs or tokens. The schema doesn't tie the template to the recipient kind; the worker enforces that.
- Job versioning: every queue payload uses `jobVersion`. None used `version`, so nothing needed reconciling. The other queues
  are unchanged, and their `idempotencyKey` is still any non-empty string.
- `ApiErrorEnvelope.error.requestId` is required.
- `Recording.file` is a `PublicFileObject`. `FileObject` is internal to api and worker.
- `Report`: structured `summary`, `decisions`, `risks` and `actionItems`. `modelRouteId` is replaced by `aiRunId` (nullable).
- `Transcript.providerId` is replaced by `provider: SttProviderId`.
- `Meeting.createdById` is nullable.
- `ExtractedTask.sourceSegmentIndexes` is replaced by `sourceSegmentIds` (uuid[]).
- `FallbackPolicy.fallbackRouteIds` is `ModelRouteId[]`.
- `avatarUrl` and `externalUrl` must be `https://` URIs.

- Upload limits: `CreateUploadRequest.sizeBytes` and recording sessions are capped at 2 GB (`MAX_UPLOAD_BYTES` = `MAX_RECORDING_SESSION_BYTES` = 2,000,000,000).
  `mimeType` must be on the explicit allowlist, optionally with a `;codecs=` parameter. Patterns like `audio/*` are no longer accepted.

- Recording chunks (Security B1 on #38):
  - `ChunkUploadUrlRequest` requires `sizeBytes` (1..`MAX_CHUNK_BYTES`) and accepts an optional `sha256` (lowercase hex). The API signs
    Content-Length and the checksum into `upload.headers`, and refuses once the running total would exceed `MAX_RECORDING_SESSION_BYTES`.
  - `CompleteRecordingSessionRequest.chunks?: [{ seq, sha256, sizeBytes? }]` (`CompletedChunk`). The server verifies there are no seq gaps, and
    checks each chunk's size and the total.
  - `MAX_RECORDING_CHUNKS` is lowered from 100,000 to 10,000, with a new alias `MAX_CHUNKS`. `seq` must be at most `MAX_CHUNKS - 1`.

- `EmailJobPayload` is now a union of strict per-template objects (Security blocker). `invitation` requires
  `recipient: { invitationId }`; `verification`, `password-reset`, `task-assigned` and `meeting-summary` require
  `recipient: { userId }`. `requestId` is opaque (`^[A-Za-z0-9_-]+$`, ≤200). The advisory
  `EMAIL_TEMPLATE_RECIPIENT` / `expectedRecipientKind()` helpers are **removed**; the schema now enforces the binding.
- `PresignedUrlDto` is a union: `GET`/`PUT` with optional `headers`, or `POST` with required `fields`. Its `url` is a
  `PresignedUrlString`, which is https, or http only for `localhost`, `127.0.0.1`, `minio` or `*.localhost` (dev MinIO). The API must issue https in
  production. `HttpsUrl` (avatar and external URLs) is still https-only.
- `ChunkUploadUrlResponse.upload` is a `SignedPutUpload`. Its `headers` are required and must include `content-length`, plus
  `x-amz-checksum-sha256` (base64 digest, `CHECKSUM_SHA256_HEADER`) when `sha256` was sent. `seq` is at most `MAX_CHUNKS - 1`.
- `InitRecordingSessionRequest.meetingId` is required.

### Added (media)

- `MEDIA_QUEUE` (`'media'`, also `QUEUE_NAMES.media`), `MEDIA_JOB_NAME`, `MEDIA_SOURCE_EXTS` / `MediaSourceExt`, and
  `MediaJobPayload` (`process_recording`; `sourceKey` is internal and never exposed to clients). This matches Media's PR #39.
- `TranscriptionJobPayload.chunkIndex?` (0..`MAX_CHUNKS - 1`) and `startMs?` (≥0) for per-chunk transcription.

### Deprecated

- `PresignedUrl` and `StorageObjectMetadata` are deprecated. They are also exported from `@meetops/contracts/legacy`.
  Migrate to `PresignedUrlDto` / `PublicFileObject` / `FileObject`. (Correction: an earlier version of this note said they
  were dropped from the main entry point. They were not; see 0.3.0.)
  `EmailAddress` and `EmailMessage` are still exported from the main entry point.

### Removed

- `ExtractedTask.acceptedTaskId`. Use `Task.extractedTaskId` instead.

## [0.1.0] - 2026-10-21

### Added

- `User.emailVerifiedAt` (optional, nullable ISO date-time), returned by `GET /auth/session`; used by web PR #188 (verification banner).

- TypeBox schemas and `Static` types for Organization, User, Membership/Role, Project, Meeting, Recording,
  FileObject, Transcript (with segments), Report, Task, ExtractedTask and IntegrationIssue.
- API error envelope, cursor and offset pagination, and `Paginated<T>`.
- Auth: `LoginRequest`, `SignupRequest`, `ForgotPasswordRequest`, `AuthSession`.
- Provider-independent job payloads for the transcription, AI and email queues. Model routing uses `provider:model`
  route ids, and there is no automatic paid fallback.
- The Phase 0 legacy types `EmailMessage`, `StorageObjectMetadata` and `PresignedUrl` are kept.
