# Changelog

All notable changes to `@meetops/contracts` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package uses [Semantic Versioning](https://semver.org/).
While the version is `0.x`, a minor bump may contain breaking changes (ADR-003).

## [0.3.3] - 2026-10-24

All changes are additive. No export was removed and no existing schema got stricter.

### Added

- Errors: `CONFLICT_REASONS` (`ALREADY_MEMBER`, `INVITATION_EXPIRED`, `INVITATION_REVOKED`,
  `INVITATION_ALREADY_ACCEPTED`, `LAST_OWNER`), the `ConflictReason` schema/type and `CONFLICT_HTTP_STATUS` (409).
  `ApiErrorEnvelope.error.reason` is an optional `ConflictReason`, sent only with `code: 'CONFLICT'`.
  `ConflictErrorEnvelope` is the 409 body type with `reason` required. Matches the 409 paths of the API in #53
  (invite/accept for an active member, expired/revoked/already-accepted invitation, last owner).
- Pagination: `DEFAULT_PAGE_LIMIT` (25, the `CursorPageQuery.limit` default).
- Package exports: `./types` also has a `default` condition (same ESM file), so `require()`, Jest and Metro
  (React Native) resolve the light entry. `.` and `./legacy` are unchanged.

### Changed

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

- TypeBox schemas and `Static` types for Organization, User, Membership/Role, Project, Meeting, Recording,
  FileObject, Transcript (with segments), Report, Task, ExtractedTask and IntegrationIssue.
- API error envelope, cursor and offset pagination, and `Paginated<T>`.
- Auth: `LoginRequest`, `SignupRequest`, `ForgotPasswordRequest`, `AuthSession`.
- Provider-independent job payloads for the transcription, AI and email queues. Model routing uses `provider:model`
  route ids, and there is no automatic paid fallback.
- The Phase 0 legacy types `EmailMessage`, `StorageObjectMetadata` and `PresignedUrl` are kept.
