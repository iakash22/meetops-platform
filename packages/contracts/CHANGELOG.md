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

### Changed (BREAKING)

- All `Id`s are `format: uuid`.
- `AuthSession`: `accessToken` removed (the session is an `__Host-` HttpOnly cookie). Added `csrfToken`,
  `activeOrganizationId` and `role`.
- Passwords must be 12–128 characters. Request schemas reject unknown properties.
- `EmailJobPayload` carries ids only (`templateId` and either `userId` or `invitationId`).
- `ApiErrorEnvelope.error.requestId` is required.
- `Recording.file` is a `PublicFileObject`. `FileObject` is internal to api and worker.
- `Report`: structured `summary`, `decisions`, `risks` and `actionItems`. `modelRouteId` is replaced by `aiRunId` (nullable).
- `Transcript.providerId` is replaced by `provider: SttProviderId`.
- `Meeting.createdById` is nullable.
- `ExtractedTask.sourceSegmentIndexes` is replaced by `sourceSegmentIds` (uuid[]).
- `FallbackPolicy.fallbackRouteIds` is `ModelRouteId[]`.
- `avatarUrl` and `externalUrl` must be `https://` URIs.

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
