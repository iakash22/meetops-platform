# Contracts guide (`@meetops/contracts`)

Source: `packages/contracts` on `integration/phase-1`, **v0.2.0** (PR #38, head `a9d9d89`, merged 2026-10-21 23:55 IST; v0.1.0 came from PR #17). It reaches `main` with the integration PR (#30). Ownership and versioning rules: ADR-003 (with ADR-004 for the database mapping). The authoritative change list is `packages/contracts/CHANGELOG.md`.

## What's in the package

TypeBox schemas (`@sinclair/typebox` `^0.34.0`), each with a `Static` TypeScript type of the same name.

| Module                                         | Main exports                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `common`, `formats`                            | `Id` (now `format: uuid`), `IsoDateTime`, `Timestamps`, `HttpsUrl`; `registerContractFormats()`                                                                                                                                                                                                                                                  |
| `domain/org`                                   | `Role`, `ROLES`, `Organization`, `User`, `Membership`, `Project`                                                                                                                                                                                                                                                                                 |
| `domain/meeting`                               | `MeetingSource`, `MeetingStatus`, `Meeting`, `MeetingParticipant`, `Transcript`, `TranscriptSegment`, `Report`, `ReportContent`, `ReportActionItem`                                                                                                                                                                                              |
| `domain/media`                                 | `FileObject` (internal to api and worker), `PublicFileObject`, `Recording`, `RecordingStatus`, media limits (`MAX_MEDIA_BYTES`, `ALLOWED_MEDIA_MIME_TYPES`, `MediaMimeType`)                                                                                                                                                                     |
| `domain/task`                                  | `TaskStatus`, `TaskPriority`, `Task`, `ExtractedTask`, `IntegrationIssue`                                                                                                                                                                                                                                                                        |
| `domain/approval`                              | `WriteApproval`                                                                                                                                                                                                                                                                                                                                  |
| `api/auth`                                     | `LoginRequest`, `SignupRequest`, `ForgotPasswordRequest`, `ResetPasswordRequest`, `VerifyEmailRequest`, `AuthSession`, `GetAuthSessionResponse`, `CsrfResponse`                                                                                                                                                                                  |
| `api/errors`                                   | `ApiErrorCode`, `ApiErrorEnvelope`                                                                                                                                                                                                                                                                                                               |
| `api/pagination`                               | `CursorPageQuery`, `OffsetPageQuery`, `CursorPage`, `OffsetPage`, `Paginated`                                                                                                                                                                                                                                                                    |
| `api/uploads`                                  | `CreateUploadRequest`/`Response`, `PresignedUrlDto`, `PresignedUrlString`, `MAX_UPLOAD_BYTES`                                                                                                                                                                                                                                                    |
| `api/recording-sessions`                       | `InitRecordingSessionRequest`/`Response`, `ChunkUploadUrlRequest`/`Response`, `SignedPutUpload`, `CompleteRecordingSessionRequest`/`Response`, `CompletedChunk`, `AbortRecordingSessionRequest`, `RecordingSource`, `AbortReason`, chunk limits (`MAX_CHUNK_BYTES`, `MAX_CHUNKS`, `MAX_RECORDING_SESSION_BYTES`, `CHUNK_UPLOAD_URL_TTL_SECONDS`) |
| `jobs`                                         | `QUEUE_NAMES` (`transcription`, `ai`, `email`, `media`), `SttProviderId`, `LlmProviderId`, `ModelRouteId`, `FallbackPolicy`, `TranscriptionJobPayload`, `AiJobPayload`, `EmailJobPayload` (per-template union), `EMAIL_QUEUE`, `EMAIL_TEMPLATE_IDS`, `MEDIA_QUEUE`, `MediaJobPayload`                                                            |
| `realtime`                                     | `MeetingStatusEvent`, `TranscriptionProgressEvent`, `TaskUpdateEvent`, `RealtimeEvent`, `REALTIME_EVENTS`, `ServerToClientEvents`                                                                                                                                                                                                                |
| `legacy` (subpath `@meetops/contracts/legacy`) | `PresignedUrl`, `StorageObjectMetadata` (deprecated), `EmailAddress`, `EmailMessage`                                                                                                                                                                                                                                                             |

## What changed from v0.1 to v0.2

Breaking changes (allowed in a `0.x` minor, per ADR-003):

- **Ids:** every `Id` is `format: uuid`.
- **Auth:**
  - `AuthSession` drops `accessToken` (sessions are `__Host-` HttpOnly cookies) and adds `csrfToken`, `activeOrganizationId` and `role`.
  - Passwords must be 12–128 characters, and request schemas reject unknown properties.
  - New error code `AUTH_FAILED`, and `ApiErrorEnvelope.error.requestId` is now required.
- **Domain:**
  - `IntegrationIssue` is tenant-scoped: `organizationId`, `integrationId` and `provider` (`github` or `jira`), unique on (organizationId, provider, externalId).
  - `Recording.file` is a `PublicFileObject`.
  - `Report` has structured content, and `aiRunId` replaces `modelRouteId`.
  - `Transcript.provider` replaces `providerId`.
  - `ExtractedTask.sourceSegmentIds` (uuid[]) replaces `sourceSegmentIndexes`, and `acceptedTaskId` is removed in favour of `Task.extractedTaskId`.
  - `Meeting.createdById` is nullable.
  - `avatarUrl` and `externalUrl` must be `https://`.
- **Jobs:**
  - `EmailJobPayload` is a union of strict per-template objects. `invitation` requires `{ invitationId }`; the others require `{ userId }`. Payloads carry no addresses, variables, URLs or tokens.
  - `FallbackPolicy.fallbackRouteIds` is `ModelRouteId[]`.
- **Uploads:**
  - `PresignedUrlDto` is a GET/PUT/POST union. Its URL is https, or http only for localhost/MinIO in dev.
  - Uploads and recording sessions are capped at 2 GB, with an explicit MIME allowlist (no `audio/*` patterns).
  - Chunk URLs require `sizeBytes` and accept an optional `sha256`; the API signs `content-length` and `x-amz-checksum-sha256` into the upload headers.
  - Completion takes a chunk manifest, and `MAX_CHUNKS` is 10,000.
  - `InitRecordingSessionRequest.meetingId` is required, and `AbortReason` adds `local_storage_exhausted`.

Additive changes: the auth, upload, recording-session, realtime, media-job and `WriteApproval` schemas listed above; `Static` types for `MeetingSource`, `TaskStatus` and `TaskPriority` (missing in v0.1); and `TranscriptionJobPayload.chunkIndex` and `startMs`.

Deprecated: `PresignedUrl` and `StorageObjectMetadata` should be imported from `@meetops/contracts/legacy`, with removal planned in 0.3.0. The main entry point still re-exports them as a transitional `@deprecated` type export so `@meetops/storage` keeps compiling.

## Using TypeBox `Static`

```ts
import { Type, type Static } from '@sinclair/typebox';

export const Organization = Type.Object({
  id: Id,
  name: Type.String({ minLength: 1, maxLength: 200 }),
  slug: Type.String({ pattern: '^[a-z0-9-]{2,64}$' }),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Organization = Static<typeof Organization>;
```

Consumers import the value (for Fastify schemas or `Value.Check`) and the type: `import { Organization, type ApiErrorEnvelope } from '@meetops/contracts';`.

## Adding or changing a contract

Per ADR-003:

1. ARCH owns `packages/contracts`. Other agents open a PR labelled `contracts` that touches only the package and its tests, and ARCH must approve it. Don't change contracts as a side effect of a feature PR.
2. Add the schema with its `Static` type in the matching module, and re-export it through that module's `index.ts`.
3. Add tests under `packages/contracts/test/`; `typecheck` covers them via `tsconfig.test.json`.
4. Add an entry under a new version heading in `CHANGELOG.md` (Keep a Changelog format: Added, Changed, Deprecated, Removed). Mark breaking changes `(BREAKING)` and bump `package.json` `version`.
5. Ping affected owners in the PR and on the implementation board, and log breaking changes in `docs/17-agents/progress-log.md`.

## Versioning

| Bump             | When                                                                                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| PATCH            | Docs, stricter tests, no schema change                                                                                                                  |
| MINOR            | Additive change. While the version is `0.x`, a minor bump may also contain breaking changes, as v0.2.0 does                                             |
| MAJOR (from 1.0) | Removing or renaming a field, making an optional field required, narrowing a union, changing a format, or changing a job payload old workers can't read |

For queue payloads, increment `jobVersion` and keep workers accepting the previous version for one release. For deprecation, use `/** @deprecated … Removal in vN */` and keep the symbol at least one minor release.
