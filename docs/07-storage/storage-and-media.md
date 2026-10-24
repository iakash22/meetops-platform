# Storage and media core (P1-MEDIA)

> **Source:** the `@meetops/storage` sections reflect the merged code on `integration/phase-1` (`packages/storage/src`), as of PR #39 (2026-10-22). So does the `@meetops/media-core` section (`packages/media-core/src`).

## `@meetops/storage`

S3-compatible `StorageService` implemented by `S3StorageService` (AWS SDK S3 client), for MinIO, Cloudflare R2 and AWS S3. The package contains no database code.

Construct it with `createStorageServiceFromEnv(env, { authorize })`, or with `new S3StorageService({ config, authorize, client?, presign?, presignPost? })`. The **`authorize` hook is required**: the constructor throws without it. `loadStorageConfig(env)` and `createS3Client(config)` are exported too.

### Object references, not keys

Every method takes a `MeetingObjectRef` (`{ orgId, meetingId, kind, objectId, ext?, index? }`), not a raw key. The service derives the key with `buildObjectKey(ref)`. It then calls `assertKeyOwnedBy(key, ref.orgId, ref.meetingId)`, then the `authorize(ref)` hook, so callers never pass client-supplied keys.

### API (`StorageService`)

| Method                                                                                     | Purpose                                                                                                           |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `putObject(ref, body, spec)`                                                               | Upload a `Buffer`, `Uint8Array`, `string` or `Readable`; returns `{ etag? }`                                      |
| `getObject(ref)`                                                                           | Returns `{ body: Readable, info }`                                                                                |
| `headObject(ref)`                                                                          | `StoredObjectInfo`, or `null` if missing                                                                          |
| `deleteObject(ref)`                                                                        | Delete                                                                                                            |
| `getPresignedUploadPost(ref, spec, opts?)`                                                 | Preferred upload: single-use presigned POST pinning exact size, Content-Type, sha256 and a one-time `uploadToken` |
| `getPresignedUploadUrl(ref, spec, opts?)`                                                  | Single-use presigned PUT signing Content-Type, Content-Length, sha256, `uploadToken` and `If-None-Match: *`       |
| `confirmUpload(ref, uploadToken)`                                                          | Consume the one-time token, then HEAD and check token metadata, size and sha256 (deletes a mismatch)              |
| `getPresignedDownloadUrl(ref, opts?)`                                                      | Presigned GET                                                                                                     |
| `createMultipartUpload(ref, spec)`                                                         | `spec` adds `partSizeBytes`; returns `{ uploadId, partCount, partSizeBytes, uploadToken }`                        |
| `getPresignedPartUrl(ref, uploadId, partNumber, partSizeBytes, partChecksumSha256, opts?)` | Presigned part PUT with a signed per-part sha256                                                                  |
| `listParts(ref, uploadId)`                                                                 | Returns `{ partNumber, etag, checksumSha256? }[]`                                                                 |
| `completeMultipartUpload(ref, uploadId, parts, uploadToken)`                               | Consumes the token, checks per-part sha256 against ListParts, completes; returns `{ etag? }`                      |
| `abortMultipartUpload(ref, uploadId)`                                                      | Abort                                                                                                             |

`spec` (`UploadSpec`): `mimeType` and `sizeBytes` (both required), plus `checksumSha256` (standard base64 sha256; REQUIRED by every presigned upload method) and optional `metadata`. `opts` (`PresignOptions`): `ttlSeconds`, capped at 600. `StoredObjectInfo` has `sizeBytes` and optional `mimeType`, `etag`, `checksumSha256`, `updatedAt` and `metadata`. Presign methods return the legacy `PresignedUrl` type; map it with `toPresignedUrlDto`, `toSignedPutUpload` or `toPublicFileObject` (`mappers.ts`).

Additional `S3StorageService` methods:

- Recording sessions (`SessionRef = { orgId, meetingId, sessionId }`):
  - `getPresignedSessionChunkUrl(ref, { seq, sizeBytes, sha256 }, mimeType, opts?)` signs one chunk PUT (sha256 hex is required; `If-None-Match: *`). The TTL is capped at 300 s, and it refuses a chunk that is already stored or that would exceed the session cap.
  - `verifySessionChunks(ref, { chunkCount, chunks? })` requires chunks `0..chunkCount-1` with no gaps or extras. On any failure it deletes all session chunks.
  - `abortSession(ref)` deletes the session's chunks.
- `verifyBucketPrivate()`: a best-effort check that the bucket is not public.
- `describeObject(ref, fileObjectId, createdAt?)`: returns an internal contracts `FileObject`. Never send it to clients.

Errors (all extend `StorageError`, with `code` `NOT_FOUND`, `FORBIDDEN`, `VALIDATION` or `STORAGE_ERROR`): `StorageNotFoundError`, `StorageAccessError` and `StorageValidationError`. S3 errors are mapped by `mapS3Error`.

### Validation

`validateUploadSpec(spec, limits)` requires `mimeType` and `sizeBytes`. The base mime type must be in `limits.allowedMimeTypes`, which defaults to the contracts `ALLOWED_MEDIA_MIME_TYPES`. Parameters are accepted only in the contracts `;codecs=` form, and the size must be from 1 to `maxObjectBytes`.

### Object key scheme

See the key layout under "Media processing worker" below. Each id segment is validated. `assertKeyOwnedBy` throws `StorageAccessError` unless the key is under `org/{orgId}/` (or `tmp/session-chunks/org/{orgId}/`), has a valid meeting segment that matches `meetingId` when given, and contains no `..`, `//` or `\`. `orgPrefix` and `parseMeetingKey` are exported too.

### Environment variables (names and meaning only)

| Variable                       | Meaning                                                                |
| ------------------------------ | ---------------------------------------------------------------------- |
| `STORAGE_PROVIDER`             | `minio`, `r2` or `s3` (default `minio`)                                |
| `STORAGE_ENDPOINT`             | S3 endpoint URL; required for `minio` and `r2`                         |
| `STORAGE_REGION`               | Region; defaults to `auto` for r2 and `us-east-1` otherwise            |
| `STORAGE_BUCKET`               | Bucket name (required)                                                 |
| `STORAGE_ACCESS_KEY_ID`        | Access key ID (secret, keep in `.env` only)                            |
| `STORAGE_SECRET_ACCESS_KEY`    | Secret key (secret, keep in `.env` only)                               |
| `STORAGE_FORCE_PATH_STYLE`     | Boolean; empty means the default (true for minio, false otherwise)     |
| `STORAGE_UPLOAD_TTL_SECONDS`   | Upload presign TTL (default 600, max 600)                              |
| `STORAGE_DOWNLOAD_TTL_SECONDS` | Download presign TTL (default 300, max 600)                            |
| `STORAGE_MAX_OBJECT_BYTES`     | Max object size (default and max: contracts `MAX_MEDIA_BYTES`, 2 GB)   |
| `STORAGE_MAX_PART_BYTES`       | Max multipart part size (5 MiB to contracts `MAX_CHUNK_BYTES`, 64 MiB) |
| `STORAGE_MAX_PARTS`            | Max parts per multipart upload (default 1000, max 10000)               |
| `STORAGE_ALLOWED_MIME_TYPES`   | Comma list overriding the default allowlist                            |

The PR #10 variable `STORAGE_PRESIGN_EXPIRES_SECONDS` is no longer read.

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

`Recording` (same PR) embeds a `FileObject` as `file`. `S3StorageService` returns `StoredObjectInfo` and the legacy `PresignedUrl` (from `@meetops/contracts/legacy`, deprecated in contracts 0.3.0); only `describeObject` returns a `FileObject`.

## `@meetops/media-core`

Wraps `ffmpeg` and `ffprobe`. `runProcess` spawns them with an argv array and no shell. FFmpeg must be installed (see `docs/00-getting-started/prerequisites.md`).

| Export                                      | Purpose                                                                                                                                                                                                           |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `probeMedia(path, opts?)`                   | Runs ffprobe (JSON) and returns `ProbeResult`: `durationSeconds`, `formatName`, `sizeBytes?`, `bitRate?`, `streams[]`, `hasAudio`, `hasVideo`. `opts.format` forces the demuxer (recommended for untrusted input) |
| `parseProbeOutput(json)`                    | Pure parser used by `probeMedia`                                                                                                                                                                                  |
| `normalizeToWav(input, output, opts?)`      | PCM s16le WAV, 16 kHz mono by default. Drops video, subtitle and data streams. Options: `sampleRate`, `channels`, `inputFormat` (`-f`), `maxDurationSeconds` (`-t`), `maxOutputBytes` (`-fs`)                     |
| `chunkAudio(input, outDir, opts?)`          | Splits a WAV into `{prefix}-NNNNN.wav` segments (`segmentSeconds` default 600, `prefix` default `chunk`). Returns `{ index, path, startSeconds, durationSeconds }[]`; offsets come from probing each chunk        |
| `buildNormalizeArgs` / `buildChunkArgs`     | Build the ffmpeg argv (for tests)                                                                                                                                                                                 |
| `DEMUXER_BY_EXT`, `demuxerForExt(ext)`      | Input allowlist: `webm`/`mkv` → `matroska`, `ogg`, `mp3`, `m4a`/`mp4` → `mov`, `wav`. Other extensions throw                                                                                                      |
| `assertProbedFormat(probe, demuxer)`        | Rejects a probe whose `formatName` is in `FORBIDDEN_FORMATS` (hls, concat, playlist, dash, image2, lavfi, rtp, tee and others) or doesn't match the expected container                                            |
| `isFfmpegAvailable(opts?)`                  | True if both binaries run                                                                                                                                                                                         |
| `runProcess`, `resolveTools`, `FfmpegError` | Low-level helpers. Failures throw `FfmpegError` with `exitCode` and `stderr`                                                                                                                                      |

Hardening:

- Every ffmpeg and ffprobe call passes `-protocol_whitelist file,pipe` (`PROTOCOL_WHITELIST`).
- stdout is capped at 4 MiB (`MAX_STDOUT_BYTES`; over the cap, the process is killed) and stderr keeps the last 64 KiB (`MAX_STDERR_BYTES`).
- By default, `chunkAudio` (`cleanup: true`) removes stale and partial `{prefix}-NNNNN.wav` files in `outDir`, and only those.

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

PR #39's diff also contains `apps/realtime` (from the stacked PR #16) and the `@meetops/storage` and `@meetops/media-core` code.
