# ADR-015: Android mobile recording in encrypted ADTS AAC segments (`audio/aac`)

- Status: **Accepted (Architecture sign-off) - Akash may override before `main`**
- Date: 2026-10-31
- Related: ADR-003 (contracts ownership), docs/mobile/security-review.md (R5, R7), #320 (encryption at rest), #328

## Context

expo-audio writes one plaintext m4a in the app cache for the whole recording; it is only sealed at Stop (R5
residual, Tester r4 issue 3). m4a segments are not byte-concatenable, and the upload pipeline (per-chunk sha256 +
whole-file sha256 in the worker's session assembly) needs one byte-concatenated source file.

Two options were compared: (a) allow `audio/aac` (raw ADTS) in the contract and record ADTS segments on the device;
(b) upload separate m4a segments and remux them on the server.

## Decision

1. Option **(a)**. `audio/aac` is added to `ALLOWED_MEDIA_MIME_TYPES` and `aac` to `MEDIA_SOURCE_EXTS` (contracts,
   additive); storage maps it to `.aac` and the download allowlist; the worker sniffs ADTS (sync `0xFFF`, layer `00`),
   walks every frame for trailing/truncated data, and probes with the forced `aac` demuxer; the web picker accepts it.
2. Android records with a native `SegmentRecorder` (AudioRecord -> MediaCodec AAC-LC, one continuous stream) in
   10 s ADTS segments. Each segment is sealed as it closes into the existing chunk format (`MOCHUNK1` envelope,
   Keystore AES-256-GCM) and journalled; its plaintext is deleted. Only the open segment is ever plaintext.
3. Chunks concatenate byte by byte, so the per-chunk and whole-file sha256 chain is unchanged (tested in the worker).
4. Crash safety follows #328: a kill while recording discards the capture (R7); a kill after Stop began resumes at
   launch (trim the open segment to whole frames, seal, enqueue with the draft or hold encrypted).
5. iOS stays on expo-audio + native sealing at Stop (AVAudioRecorder cannot write ADTS). This is an explicit,
   documented exception in docs/mobile/security-review.md.
6. Option (b) is **deferred**. It is revisited if iOS needs the same guarantee.

## Consequences

- New accepted media type on every upload path, so it is covered by the same magic-byte, container-end, ffprobe,
  duration and size checks as the others.
- Native code (Kotlin) is not compiled or device-tested on the box; device checks are listed in the PR.
- **Key binding.** The Keystore key is **not bound to user authentication** (no
  `setUserAuthenticationRequired`): background capture and post-kill recovery must seal and open without a prompt.
  Anyone who can run code as the app on an unlocked device can use it; it is never exportable. On devices where the
  key is software-only (no TEE/StrongBox: emulators, old devices), release builds **warn and log** at the first
  recording rather than refusing, so those devices can still record. No recovery UI is planned.
- Reversible: removing `audio/aac` from the allowlist and the Android module returns to the #328 behaviour.
