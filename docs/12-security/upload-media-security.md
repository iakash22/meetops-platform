# Upload and media security checklist

## 1. Size and type limits

- [ ] Allowlist types: audio `mp3, m4a/mp4 audio, wav, webm, ogg, flac`; video `mp4, webm, mov`; transcripts `vtt, srt, txt, json` (import).
- [ ] Max size per plan (default 2 GB media, 10 MB transcript); max duration (default 4 h) checked after probe.
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
