# Storage and media core (P1-MEDIA)

> **Note:** This page describes **open PR #10** (`feat/storage-and-media-core`), which is not merged yet. Source: head commit `6857903341b133daed9ec4b7f6941658d5dbe98e`, read via `gh pr view 10` / `gh pr diff 10`.

## `@meetops/storage`

S3-compatible `StorageService` implemented by `S3StorageService` (AWS SDK S3 client), for MinIO, Cloudflare R2 and AWS S3. The package contains no database code.

Construct it with `createStorageServiceFromEnv(env?, opts?)`, or with `new S3StorageService({ config, client?, validators?, ownershipCheck?, presign? })`. `loadStorageConfig(env)` and `createS3Client(config)` are exported too.

### API

| Method                                                              | Purpose                                                               |
| ------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `putObject(key, body, options?)`                                    | Upload a `Buffer`, `Uint8Array`, `string` or `Readable`               |
| `getObject(key)`                                                    | Returns `{ body: Readable, metadata }`; throws `StorageNotFoundError` |
| `headObject(key)`                                                   | Metadata, or `null` if missing                                        |
| `deleteObject(key)`                                                 | Delete                                                                |
| `getPresignedUploadUrl(key, options?)`                              | Presigned PUT                                                         |
| `getPresignedDownloadUrl(key, expiresInSeconds?)`                   | Presigned GET                                                         |
| `createMultipartUpload(key, options?)`                              | Returns `{ key, uploadId }`                                           |
| `getPresignedPartUrl(key, uploadId, partNumber, expiresInSeconds?)` | `partNumber` must be 1..10000                                         |
| `listParts(key, uploadId)`                                          | Returns `{ partNumber, etag }[]`                                      |
| `completeMultipartUpload(key, uploadId, parts)`                     | Needs at least one part; parts are sorted by number                   |
| `abortMultipartUpload(key, uploadId)`                               | Abort                                                                 |

`options` (`PutObjectOptions`): `contentType`, `contentLength`, `metadata`, `expiresInSeconds`.

Errors: `StorageValidationError`, `StorageNotFoundError`, `StorageAccessError`.

### Validation and ownership hooks

- `validators: ValidationHook[]` run on uploads, receiving `{ key, contentType, contentLength }`. Two built-in validators are provided:
  - `contentTypeValidator(allowed)` requires a content type and checks the base type against the list. `DEFAULT_AUDIO_VIDEO_TYPES` covers mpeg, mp4, wav, x-wav, webm, ogg and flac audio, plus mp4, webm and quicktime video.
  - `sizeValidator(maxBytes, minBytes = 1)` checks the size range.
- `ownershipCheck: OwnershipHook` runs before every key-addressed operation; throwing denies the operation. Pair it with `assertKeyOwnedBy(key, orgId)`.
- Keys that are empty or start with `/` are always rejected.

### Object key scheme

```text
org/{orgId}/meetings/{meetingId}/{...parts}
```

- `orgPrefix(orgId)` returns `org/{orgId}/`. `buildMeetingKey(orgId, meetingId, ...parts)` and `parseMeetingKey(key)` build and parse keys.
- Each segment must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$` and must not contain `..`.
- `assertKeyOwnedBy` throws `StorageAccessError` unless the key starts with the org prefix and contains no `..` or `//`.

### Environment variables (names and meaning only)

| Variable                          | Meaning                                                                                        |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| `STORAGE_PROVIDER`                | `minio`, `r2` or `s3` (default `minio`)                                                        |
| `STORAGE_ENDPOINT`                | S3 endpoint URL; required for `minio` and `r2`                                                 |
| `STORAGE_REGION`                  | Region; defaults to `auto` for r2 and `us-east-1` otherwise                                    |
| `STORAGE_BUCKET`                  | Bucket name (required)                                                                         |
| `STORAGE_ACCESS_KEY_ID`           | Access key ID (secret, keep in `.env` only)                                                    |
| `STORAGE_SECRET_ACCESS_KEY`       | Secret key (secret, keep in `.env` only)                                                       |
| `STORAGE_FORCE_PATH_STYLE`        | Path-style addressing; defaults to true for minio                                              |
| `STORAGE_PRESIGN_EXPIRES_SECONDS` | Default presign expiry, integer 1..604800 (default 900). New in this PR, not in `.env.example` |

### Contract: `FileObject` (from PR #17)

Stored-object metadata crossing package boundaries uses the `FileObject` contract from `@meetops/contracts`, added in **open PR #17** (`feat/core-contracts`, read at `8a189c87e28ab7a81b14d8b94b0ca16990221561`):

| Field            | Type                                                                |
| ---------------- | ------------------------------------------------------------------- |
| `id`             | `Id`                                                                |
| `organizationId` | `Id`                                                                |
| `provider`       | string, a registry key (e.g. `s3`, `minio`, `local`)                |
| `bucket`         | string                                                              |
| `key`            | string; use the `org/{orgId}/meetings/{meetingId}/...` scheme above |
| `mimeType`       | string                                                              |
| `sizeBytes`      | integer >= 0                                                        |
| `checksumSha256` | optional string                                                     |
| `createdAt`      | `IsoDateTime`                                                       |

`Recording` (same PR) embeds a `FileObject` as `file`. `S3StorageService` itself returns the Phase 0 `StorageObjectMetadata` and `PresignedUrl` types (kept in `legacy.ts` in #17), not `FileObject`.

## `@meetops/media-core`

Wraps `ffmpeg` and `ffprobe`, spawned with an argv array and no shell. FFmpeg must be installed (see `docs/00-getting-started/prerequisites.md`).

| Function                                | Purpose                                                                                                                                                    |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `probeMedia(path, opts?)`               | ffprobe JSON parsed into `ProbeResult`: `durationSeconds`, `formatName`, `sizeBytes?`, `bitRate?`, `streams[]`, `hasAudio`, `hasVideo`                     |
| `parseProbeOutput(json)`                | Pure parser used by `probeMedia`                                                                                                                           |
| `normalizeToWav(input, output, opts?)`  | Converts to PCM s16le WAV, 16 kHz mono by default (`sampleRate`, `channels` options); drops video, subtitle and data streams                               |
| `chunkAudio(input, outDir, opts?)`      | Splits into fixed-length WAV segments (`segmentSeconds` default 600, `prefix` default `chunk`); returns `{ index, path, startSeconds, durationSeconds }[]` |
| `buildNormalizeArgs` / `buildChunkArgs` | Build the ffmpeg argv (for tests)                                                                                                                          |
| `isFfmpegAvailable(opts?)`              | True if both binaries run                                                                                                                                  |
| `runProcess`, `resolveTools`            | Low-level helpers; failures throw `FfmpegError` with `exitCode` and `stderr`                                                                               |

Options (`MediaToolsOptions`): `ffmpegPath` (env `FFMPEG_PATH`, default `ffmpeg`), `ffprobePath` (env `FFPROBE_PATH`, default `ffprobe`), `timeoutMs` (default 10 minutes, then SIGKILL) and `signal` (an `AbortSignal`).

## Tests

S3 calls are mocked with `aws-sdk-client-mock`. The ffmpeg tests use the real binary and are skipped if it's missing.

## Media processing worker (PR #39, merged)

Merged into `integration/phase-1` by PR #39 (merge commit `50e69d4`). Code: `apps/worker/src/media/`.

- Queue and job name come from `@meetops/contracts` (`MEDIA_QUEUE`, `MEDIA_JOB_NAME`); the payload is checked against the contracts `MediaJobPayload` schema.
- Steps: check the source key belongs to the recording's org and meeting, HEAD and download it via `@meetops/storage`, probe, normalize to 16 kHz mono WAV, chunk, upload the normalized file and chunks, then enqueue one transcription job per chunk.
- Object keys (`buildObjectKey` in `packages/storage/src/keys.ts`), under `org/{orgId}/meetings/{meetingId}/`:
  - `recordings/{id}.{ext}`
  - `processed/{recordingId}/normalized.wav`
  - `processed/{recordingId}/chunks/{index}.wav`
  - Session chunks use the `tmp/session-chunks/` prefix.
- Transcription payloads (contracts `TranscriptionJobPayload`) carry `chunkIndex` and `startMs`, use `diarize: true`, and the STT provider from the job, then the worker default (`STT_PROVIDER_ID`, default `assemblyai`).
- Idempotency: normalized and chunk FileObject ids are UUID v5 values from a fixed namespace (`MEDIA_UUID_NAMESPACE`, which must not change). BullMQ job ids are deterministic: `media_{org}_{recording}` and `transcribe_{org}_{recording}_{index:5}`. Media jobs use 3 attempts with exponential backoff (5 s).
- Limits: source size up to the contracts `MAX_MEDIA_BYTES` (checked by HEAD and while streaming) and duration up to 4 hours by default. Failures throw `MediaJobError` codes such as `forbidden`, `source_not_found`, `source_too_large`, `no_audio_stream`, `source_too_long` and `no_chunks`.
- Realtime: emits `meeting:status` and `transcription:progress` via `@socket.io/redis-emitter` to `org:{orgId}:meeting:{meetingId}` and `org:{orgId}`. Room names must match `apps/realtime`.
- No STT runs in this job.

Worker environment variables (names only): `REDIS_URL`, `STT_PROVIDER_ID`, `MEDIA_WORKER_CONCURRENCY` (default 1, max 16), `MEDIA_CHUNK_SECONDS` (default 600, 10–3600), `MEDIA_MAX_SOURCE_BYTES`, `MEDIA_MAX_DURATION_SECONDS` (max 24 h) and `MEDIA_TMP_DIR`. PR #39 also changed `.env.example` so `STORAGE_FORCE_PATH_STYLE` is empty instead of `true`.

PR #39's diff also contains `apps/realtime` (from the stacked PR #16) and the `@meetops/storage` and `@meetops/media-core` code. The API tables above describe PR #10 and may be out of date (for example, `putObject` now takes a `MeetingObjectRef`).
