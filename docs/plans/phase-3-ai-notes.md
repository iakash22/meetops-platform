# Phase 3 AI pipeline: notes and parked decisions

Worker-side AI pipeline in `apps/worker/src/ai`, behind provider interfaces, plain `fetch` only (no SDKs, no new
dependencies, no lockfile change). Every test uses mocked fetch or fake providers; no test makes a network call.

## PR 1: feat/worker-transcription-provider

- `providers/transcription-provider.ts`: `TranscriptionProvider` port (`transcribe`, `fetchResult`).
- `providers/assemblyai.ts`: AssemblyAI adapter. Upload (bytes) or URL submit, polling or webhook mode
  (`ASSEMBLYAI_WEBHOOK_URL` + shared-header secret, verified with `timingSafeEqual`), speaker labels mapped from
  utterances, per-request and overall timeouts, error mapping to `ProviderError` codes
  (`auth`, `rate_limited`, `unavailable`, `invalid_request`, `timeout`, `provider_failed`, `bad_response`).
  Error messages carry no key, no URL and no response body.
- `recording-transcription.ts`: whole-recording job, stored through the #212 `TranscriptRepository` as chunk 0
  of a one-chunk recording, so it shares merge and storage with the chunk pipeline.
  - Idempotent: the raw provider result is stored first (first write wins), so retries never call the provider again
    once it has answered; a revision is written by compare-and-set only when content changes.
  - Failed status: on a permanent error, or the final BullMQ attempt, the revision-0 anchor gets `status = failed`
    (`markTranscriptFailed`, new on the Prisma repository).
  - Logs carry ids and error codes only, never the audio URL or transcript text.
- Not registered on a queue yet: there is no contracts job payload for whole-recording transcription. The existing
  chunk consumer (`QUEUE_NAMES.transcription`) is unchanged.

## Parked decisions (need Shubham). Defaults in brackets are what the code does today.

1. STT model: [`universal` via `ASSEMBLYAI_SPEECH_MODEL`, language auto-detect unless the job passes one].
2. Polling vs webhook: [polling, 5 s interval, 30 min overall budget]. Webhook mode needs a public API route
   (`verifyAssemblyAiWebhook` and `parseAssemblyAiWebhook` are ready) and a webhook secret.
3. Audio delivery: [short-lived presigned https URL from storage]; byte upload is supported as a fallback.
4. Data retention at the provider: [not requested]. AssemblyAI keeps uploads and transcripts until deleted; decide
   whether to call `DELETE /v2/transcript/:id` after storing.
5. Re-submission cost: a crash between the provider answer and the DB write re-submits the audio (no provider
   idempotency key). [Accepted]; storing `providerJobId` before polling would close it.
6. A later success after `failed` leaves the anchor at `failed`, while revision >= 1 is `ready`. Readers should use the
   latest revision >= 1. [Accepted.]
7. PII redaction (AssemblyAI `redact_pii`): [off]. Turning it on changes transcript text for every downstream step.
