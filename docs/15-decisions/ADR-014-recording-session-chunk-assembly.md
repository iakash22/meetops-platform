# ADR-014: Recording session chunk assembly (worker streaming concat)

- Status: **Proposed - needs Architecture and Security sign-off**
- Date: 2026-10-28
- Related: ADR-004 (media pipeline), ADR-010 (organization keys), ADR-013 (outbox); security review B 4.2

## Context

Browser and extension recordings upload as a resumable session of signed parts
(`tmp/session-chunks/organizations/{org}/meetings/{meeting}/sessions/{session}/{seq}.part`, ≤ 64 MiB each, ≤ 1.4e9
bytes in total). `process_recording` needs one source object at
`organizations/{org}/meetings/{meeting}/recordings/{recordingId}.{ext}`. Nothing joined the parts.

## Decision

1. On session complete the API enqueues `assemble_recording_session` on `MEDIA_QUEUE` (contracts
   `AssembleRecordingSessionJobPayload`, BullMQ `jobId = assemble_recording_session:{sessionId}`).
2. The media worker concatenates the parts in `seq` order through `StorageService` as one streamed `PutObject`
   (`apps/worker/src/media/assemble-session.ts`):
   - streaming only: one read slice in memory at a time, never the whole recording;
   - every part's size and SHA-256 is checked against the value the API signed; a mismatch aborts the upload;
   - the 1.4e9-byte cap (`MAX_RECORDING_SESSION_BYTES`) is checked on the signed sizes up front and on the bytes
     actually read while streaming; crossing it aborts immediately;
   - the written object is verified (HEAD size + SHA-256 read-back) before anything else happens.
3. Idempotency: the recording id, source FileObject id and target key are uuidv5 of the session id. The verified
   size + SHA-256 are recorded on the source FileObject and linked via `recording_sessions.recording_id`; a retry that
   finds that record and an object of the same size skips the concat and only re-runs the post-steps.
4. Parts are deleted only after the assembled object is verified and recorded. Any failure leaves every part in
   place (a partial target is removed); the `tmp/` lifecycle rule expires abandoned parts.
5. Then `process_recording` is enqueued (`jobId = media_{org}_{recordingId}`, duplicate adds are ignored).
6. On the final failed attempt the worker writes a `meeting.processing_failed` outbox row (ADR-013; ids and an error
   code only) and emits `meeting:status failed`. `process_recording` does the same with `subjectType = recording`.

## Consequences

- One extra read of the assembled object (verification) and a transient 2x storage footprint per session.
- Peak memory is constant; worker time is linear in recording size.

## Later optimization

S3 multipart **compose** (`UploadPartCopy` of each part into one multipart upload) would avoid streaming the bytes
through the worker. Not adopted now: R2/MinIO parity, the 5 MiB minimum part size for all but the last part, and
the per-part checksum verification would still need a read. Revisit if assembly time or egress becomes a problem.
