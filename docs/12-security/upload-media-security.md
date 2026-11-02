# Upload and media security checklist

## 1. Size and type limits

**G9 decision (ARC-2, `@meetops/contracts` 0.4.1).** The contracts constants are the source of truth; tests (UP-05,
UP-10) use them, not literals.

| Limit                                | Decision                                 | Constant                                                                     | Rejected alternative                                                                                                      |
| ------------------------------------ | ---------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Max media object / recording session | 1.4 GB (1_400_000_000 bytes)             | `MAX_MEDIA_BYTES`, `MAX_RECORDING_SESSION_BYTES`, `MAX_UPLOAD_BYTES`         | 2 GB: does not fit the worker tmpfs budget (source + normalised WAV + chunks on one job)                                  |
| ClamAV scan limits (clamd)           | 1400M = 1_468_006_400 bytes              | `StreamMaxLength`, `MaxFileSize`, `MaxScanSize` in `infra/clamav/clamd.conf` | Must stay ≥ `MAX_MEDIA_BYTES` and < 2 GB (ClamAV ceiling). The ClamAV default (100M) would block every large upload       |
| Max duration                         | 4 h (14_400_000 ms), checked after probe | `MAX_DURATION_MS`                                                            | 24 h: a 24 h 16 kHz mono WAV is about 2.76 GB, over the tmpfs budget; 4 h matches the worker default `maxDurationSeconds` |
| Presigned GET TTL                    | ≤ 300 s                                  | `MAX_PRESIGNED_GET_TTL_SECONDS`                                              | —                                                                                                                         |
| Presigned chunk PUT TTL              | 300 s                                    | `CHUNK_UPLOAD_URL_TTL_SECONDS`                                               | —                                                                                                                         |
| Max chunks / chunk size              | 10_000 chunks, 64 MiB each               | `MAX_RECORDING_CHUNKS`, `MAX_CHUNK_BYTES`                                    | —                                                                                                                         |

A plan may lower these limits, never raise them. Follow-up for the storage owner: `@meetops/storage` still allows a
GET TTL up to 600 s (`MAX_PRESIGN_TTL_SECONDS`); its default (300 s) already meets the bound, and GET presigns must be
capped at `MAX_PRESIGNED_GET_TTL_SECONDS`.

- [ ] Allowlist types: audio `mp3, m4a/mp4 audio, wav, webm, ogg, flac`; video `mp4, webm, mov`; transcripts `vtt, srt, txt, json` (import).
- [ ] Max size per plan, at most the G9 limits above (1.4 GB media, 10 MB transcript); max duration (4 h) checked after probe.
- [ ] Presign enforces `content-length-range` and `Content-Type`.
- [ ] Per-org storage quota and concurrent-upload limits.

> Limit values are pending ARC-2 (G9). Contracts currently set `MAX_MEDIA_BYTES = 1_400_000_000`, `MAX_RECORDING_CHUNKS = 10_000`, `MAX_DURATION_MS = 24 h` and `CHUNK_UPLOAD_URL_TTL_SECONDS = 300`, which differ from the defaults above. ARC-2 records the decision here and in the contracts; tests (UP-05, UP-10) use the contracts constants, not literals.

## 2. Content validation

- [ ] Magic-byte check (e.g. `file-type`) on the stored object, not the client-declared MIME or extension; mismatch → reject.
- [ ] `ffprobe` (sandboxed) validates container/codec; reject unexpected streams.
- [ ] Text imports: UTF-8 validation, size cap, parsed with strict parsers.

## 3. Presigned URLs

- [ ] Server-generated key from `@meetops/storage` `buildObjectKey` (ADR-010): `organizations/{organizationId}/meetings/{meetingId}/recordings/{objectId}.{ext}`; session chunks under `tmp/session-chunks/organizations/{organizationId}/meetings/{meetingId}/sessions/{sessionId}/{seq}.part`. The client never chooses or sends a key, bucket or `organizationId` (XT-16, UP-13); the key is stored in `file_objects.storage_key` and read back from there, never rebuilt.
- [ ] TTL ≤ 10 min for PUT, ≤ 5 min for GET; scoped to a single object and method.
- [ ] Issued only after the CASL check (`create FileObject` / `create` or `update RecordingSession`, rbac-matrix.md); the upload record (`FileObject` with `organizationId`, status `pending_upload`) is created first inside `runWithOrganizationContext`.
- [ ] Completion endpoint verifies size, checksum (SHA-256), and that the key belongs to the caller's organization with `assertKeyOwnedBy(key, organizationId, meetingId)`; any mismatch leaves the `FileObject` pending (UP-19). Legacy `org/{organizationId}/` keys are accepted for reads in ADR-010 phase A only and never for new uploads.
- [ ] Bucket private, public access blocked, SSE enabled, CORS limited to web origin.

## 4. Malware scanning

Decision: ADR-018. The worker streams each upload to a clamd sidecar (`UPLOAD_SCAN_CLAMAV=true`). The scan is
fail-closed: if clamd is unreachable, the job retries and the final attempt quarantines the upload.

- **Limits.** `StreamMaxLength`, `MaxFileSize` and `MaxScanSize` are 1400M (1_468_006_400 bytes). That is about
  68 MB above `MAX_MEDIA_BYTES` (1_400_000_000) and below ClamAV's 2 GB ceiling, so any upload the API accepts is
  scanned in full. If `MAX_MEDIA_BYTES` is raised, raise these limits first (the worker config test fails otherwise).
- **Over the limit.** `AlertExceedsMax yes`: a file over a scan limit (size, or `MaxScanTime` = 10 min) is reported as
  `Heuristics.Limits.Exceeded.*` instead of a partly-scanned "OK". A stream over `StreamMaxLength` is refused
  (`INSTREAM size limit exceeded. ERROR`). Both are fail-closed. **Today** a `Heuristics.Limits.Exceeded.*` reply is
  handled like any other `FOUND`: the upload is quarantined as `malware_detected`. An ERROR reply is a `ClamdError`:
  the job retries, and the last attempt quarantines it (`scan_unavailable`). MAL-2 gives limit hits their own error
  code and metric, so they are no longer labelled `malware_detected`.
- **Client.** Only the exact reply `stream: OK\0` is clean. Every other reply (ERROR, malformed, empty, extra text),
  a timeout, a socket error or a file read error rejects (`apps/worker/test/clamd.test.ts`). **Today** the worker
  client has one fixed 120 s total timeout, below clamd's `MaxScanTime` (600 s): a scan slower than 120 s is
  abandoned by the worker and ends quarantined (`scan_unavailable`) after retries, while clamd keeps scanning.
  MAL-2 makes the timeout size-aware, above `MaxScanTime`.
- **Signatures.** The image is pinned by version and digest (ClamAV 1.4 LTS). freshclam runs daily (`--checks=1`) in
  its own `clamav-freshclam` container, and clamd reloads the shared database through `SelfCheck` without blocking scans.
- **Isolation (MAL-1b).** clamd's TCP protocol is unauthenticated (`SHUTDOWN`, `RELOAD`), so clamd sits only on the
  internal `clamav-internal` network, which only the worker joins: no egress and no other neighbour. Only freshclam
  has egress, and it cannot reach clamd. Both run as the `clamav` user with `cap_drop: [ALL]` and no added
  capabilities.
- **Verified.** A clean 1_400_000_000-byte WAV scanned `OK` in about 35 s through INSTREAM with this config; EICAR was
  `FOUND`; a 1_468_006_401-byte stream was refused at the limit.

Deployment settings: docs/13-ops/containers-and-ci.md.

- [ ] New objects land in `quarantine` state; ClamAV (or provider scanner) runs before processing; infected → delete + audit + notify.
- [ ] Downloads/playback only from `clean` objects.

## 5. FFmpeg sandboxing and limits

- [ ] Separate media worker container: non-root, read-only root FS, tmpfs scratch, no network (fetch via pre-downloaded file or presigned GET only), seccomp/AppArmor default, drop all capabilities.
- [ ] `-protocol_whitelist file,pipe`; disable network protocols, concat/HLS demuxers on untrusted input.
- [ ] cgroup limits: CPU, memory (e.g. 2 GB), PIDs; wall-clock timeout per job; output size cap.
- [ ] Pinned FFmpeg version, patched promptly (track CVEs).
- [ ] Invoke via `execFile`/`spawn` with argument array — never shell strings.

## 6. Filename handling

- [ ] Original filename stored as metadata only (length ≤ 255, NFC normalized, control chars stripped); never used in paths or shell.
- [ ] `Content-Disposition: attachment; filename*=UTF-8''<encoded>` on download; render escaped in UI.

## 7. Recording consent

- [ ] Notice: recorder bot uses visible name ("MeetOps Recorder") and posts a chat notice on join; uploads require uploader attestation of consent.
- [ ] Per-org consent settings: required notice text, all-party vs one-party mode, auto-skip meetings with external participants, retention period.
- [ ] Server-side attestation (G11): upload init and recording-session init require a consent attestation in the request (shape per ARC-2); without it the API returns 422 and creates nothing (UP-16, UP-17). The server persists it in `consent_attestations` (DB-3: `org_id`, subject id, `consent_version`, method, `attested_by_user_id`, `attested_at`; RLS-forced, append-only). `attested_by_user_id` and `org_id` come from the session, never the body (UP-18).
- [ ] Processing blocked if required consent attestation missing: complete fails with 422 and no media job is enqueued; the worker re-checks before processing (UP-16).
- [ ] Audit: consent attestation, who started recording, notices posted, deletion requests.
- [ ] Retention and deletion: org-configurable retention; hard delete of media + derived transcripts/embeddings on request.
