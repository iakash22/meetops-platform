# Changelog

All notable changes to `@meetops/contracts` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this package uses [Semantic Versioning](https://semver.org/).
While the version is `0.x`, a minor bump may contain breaking changes (ADR-003).

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

### Changed (BREAKING)

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

### Deprecated

- `PresignedUrl` and `StorageObjectMetadata` are no longer exported from the main entry point. Import them from
  `@meetops/contracts/legacy` while migrating to `PresignedUrlDto` / `PublicFileObject` / `FileObject`. Removal is planned in 0.3.0.
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
