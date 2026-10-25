# Upload and media security checklist

## 1. Size and type limits

**G9 decision (ARC-2, `@meetops/contracts` 0.4.1).** The contracts constants are the source of truth; tests (UP-05,
UP-10) use them, not literals.

| Limit                                | Decision                                 | Constant                                                             | Rejected alternative                                                                                                      |
| ------------------------------------ | ---------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Max media object / recording session | 1.4 GB (1_400_000_000 bytes)             | `MAX_MEDIA_BYTES`, `MAX_RECORDING_SESSION_BYTES`, `MAX_UPLOAD_BYTES` | 2 GB: does not fit the worker tmpfs budget (source + normalised WAV + chunks on one job)                                  |
| Max duration                         | 4 h (14_400_000 ms), checked after probe | `MAX_DURATION_MS`                                                    | 24 h: a 24 h 16 kHz mono WAV is about 2.76 GB, over the tmpfs budget; 4 h matches the worker default `maxDurationSeconds` |
| Presigned GET TTL                    | ≤ 300 s                                  | `MAX_PRESIGNED_GET_TTL_SECONDS`                                      | —                                                                                                                         |
| Presigned chunk PUT TTL              | 300 s                                    | `CHUNK_UPLOAD_URL_TTL_SECONDS`                                       | —                                                                                                                         |
| Max chunks / chunk size              | 10_000 chunks, 64 MiB each               | `MAX_RECORDING_CHUNKS`, `MAX_CHUNK_BYTES`                            | —                                                                                                                         |

A plan may lower these limits, never raise them. Follow-up for the storage owner: `@meetops/storage` still allows a
GET TTL up to 600 s (`MAX_PRESIGN_TTL_SECONDS`); its default (300 s) already meets the bound, and GET presigns must be
capped at `MAX_PRESIGNED_GET_TTL_SECONDS`.

- [ ] Allowlist types: audio `mp3, m4a/mp4 audio, wav, webm, ogg, flac`; video `mp4, webm, mov`; transcripts `vtt, srt, txt, json` (import).
- [ ] Max size per plan, at most the G9 limits above (1.4 GB media, 10 MB transcript); max duration (4 h) checked after probe.
- [ ] Presign enforces `content-length-range` and `Content-Type`.
- [ ] Per-org storage quota and concurrent-upload limits.

## 2. Content validation

- [ ] Magic-byte check (e.g. `file-type`) on the stored object, not the client-declared MIME or extension; mismatch → reject.
- [ ] `ffprobe` (sandboxed) validates container/codec; reject unexpected streams.
- [ ] Text imports: UTF-8 validation, size cap, parsed with strict parsers.

## 3. Presigned URLs

- [ ] Server-generated key `org/{orgId}/uploads/{uploadId}/source` — client never chooses the key.
- [ ] TTL ≤ 10 min for PUT, ≤ 5 min for GET; scoped to a single object and method.
- [ ] Issued only after CASL check; upload record (`FileObject` with `orgId`, status `pending`) created first.
- [ ] Completion endpoint verifies size, checksum (SHA-256), and that the key belongs to caller's org.
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
- [ ] Processing blocked if required consent attestation missing.
- [ ] Audit: consent attestation, who started recording, notices posted, deletion requests.
- [ ] Retention and deletion: org-configurable retention; hard delete of media + derived transcripts/embeddings on request.
